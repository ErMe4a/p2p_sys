import hmac
import hashlib
import time
import logging
import requests
import urllib3
from datetime import datetime
from django.utils import timezone
from django.utils.timezone import make_aware
from .models import UnprocessedOrder, Order, IgnoredOrder  # <-- добавлен IgnoredOrder

# Отключаем предупреждения о SSL
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

# Тянем ордера только начиная с этой даты (24.02.2026)
DATE_FROM_MS = int(datetime(2026, 2, 24).timestamp() * 1000)

BASE_URL = "https://api.mexc.com"

# Статусы MEXC которые считаются отменёнными — такие ордера не берём
MEXC_CANCELLED_STATES = {"CANCEL", "CANCELLED", "CANCELED", "APPEAL_CANCEL", "APPEAL_CANCELLED"}


def sync_mexc_orders(user):
    """
    Синхронизация ЗАВЕРШЁННЫХ P2P ордеров MEXC (orderDealState=DONE).

    Алгоритм:
      1. Проверяем ключи.
      2. Собираем ID уже известных ордеров.
      3. Постранично тянем завершённые ордера начиная с DATE_FROM_MS.
      4. Парсим, фильтруем дубли и отменённые.
      5. Массово сохраняем в UnprocessedOrder.

    Возвращает: количество добавленных ордеров (int).
    """

    # ── 1. Проверка ключей ────────────────────────────────────────────────────
    if not getattr(user, 'mexc_api_key', None) or not getattr(user, 'mexc_api_secret', None):
        logger.debug("User %s: MEXC keys not set, skipping.", user.username)
        return 0

    # ── 2. Чёрный список уже известных ID ────────────────────────────────────
    processed_ids = set(
        Order.objects.filter(user=user, exchange_type="MEXC")
        .exclude(external_id="")
        .exclude(external_id__isnull=True)
        .values_list("external_id", flat=True)
    )
    unprocessed_ids = set(
        UnprocessedOrder.objects.filter(user=user, exchange_type="MEXC")
        .values_list("order_id", flat=True)
    )
    ignored_ids = set(
        IgnoredOrder.objects.filter(user=user)
        .values_list("order_id", flat=True)
    )
    ignore_ids = processed_ids | unprocessed_ids | ignored_ids

    # ── 3. Постраничная выгрузка ──────────────────────────────────────────────
    raw_items = []
    page = 1
    end_time = int(time.time() * 1000)

    while True:
        data, error = _fetch_page(user, page, DATE_FROM_MS, end_time)

        if error:
            logger.error("MEXC API error for %s: %s", user.username, error)
            break

        items = data.get("data") or []
        if not items:
            break

        raw_items.extend(items)
        logger.debug("MEXC [%s] page %d: got %d items", user.username, page, len(items))

        page_info = data.get("page", {})
        total_pages = page_info.get("totalPage", 1)

        if page >= total_pages:
            break

        page += 1

    if not raw_items:
        logger.debug("MEXC [%s]: no items from API.", user.username)
        return 0

    # ── 4. Парсим и фильтруем ─────────────────────────────────────────────────
    new_orders = []
    seen_in_batch = set()

    for item in raw_items:
        created_ms = int(item.get("createTime") or 0)
        if created_ms < DATE_FROM_MS:
            continue

        # ── ФИЛЬТР ОТМЕНЁННЫХ ────────────────────────────────────────────────
        # MEXC может игнорировать orderDealState в параметрах запроса и возвращать
        # все ордера — поэтому фильтруем по полю в ответе на стороне Python.
        # Возможные поля: orderDealState, state, status, dealState
        deal_state = (
            item.get("orderDealState")
            or item.get("dealState")
            or item.get("state")
            or item.get("status")
            or ""
        )
        if str(deal_state).upper() in MEXC_CANCELLED_STATES:
            logger.debug(
                "MEXC [%s]: skipping cancelled order %s (state=%s)",
                user.username, item.get("advOrderNo"), deal_state
            )
            continue
        # ─────────────────────────────────────────────────────────────────────

        order_id = str(item.get("advOrderNo") or "").strip()
        if not order_id:
            continue
        if order_id in ignore_ids:
            continue
        if order_id in seen_in_batch:
            continue

        seen_in_batch.add(order_id)
        ignore_ids.add(order_id)

        operation_type = str(item.get("side", "BUY")).upper()

        price         = _to_float(item.get("price"))
        crypto_amount = _to_float(item.get("tradableQuantity"))
        fiat_amount   = _to_float(item.get("amount"))

        if crypto_amount == 0 and price > 0 and fiat_amount > 0:
            crypto_amount = round(fiat_amount / price, 8)

        aware_dt = _parse_date(created_ms)

        new_orders.append(
            UnprocessedOrder(
                user=user,
                order_id=order_id,
                operation_type=operation_type,
                amount=crypto_amount,
                price=price,
                cost=fiat_amount,
                exchange_type="MEXC",
                created_at=aware_dt,
            )
        )

    # ── 5. Массовое сохранение ────────────────────────────────────────────────
    if new_orders:
        UnprocessedOrder.objects.bulk_create(new_orders, ignore_conflicts=True)
        logger.info("MEXC [%s]: saved %d new orders.", user.username, len(new_orders))

    return len(new_orders)


# ── Вспомогательные функции ───────────────────────────────────────────────────

def _fetch_page(user, page: int, start_time: int, end_time: int):
    """
    Запрашивает одну страницу ордеров с MEXC.
    Возвращает (data, error_message).
    """
    timestamp = int(time.time() * 1000)

    params = {
        "orderDealState": "DONE",
        "page": page,
        "limit": 50,
        "startTime": start_time,
        "endTime": end_time,
        "timestamp": timestamp,
    }

    query_string = "&".join(f"{k}={v}" for k, v in params.items())
    signature = hmac.new(
        user.mexc_api_secret.encode("utf-8"),
        query_string.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

    url = f"{BASE_URL}/api/v3/fiat/market/order/pagination?{query_string}&signature={signature}"

    headers = {
        "X-MEXC-APIKEY": user.mexc_api_key,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    }

    try:
        response = requests.get(url, headers=headers, timeout=30, verify=False)
        data = response.json()

        if data.get("code") != 0:
            return None, f"code={data.get('code')} msg={data.get('msg')}"

        return data, None

    except Exception as e:
        return None, str(e)


def _to_float(value) -> float:
    try:
        return float(value or 0)
    except (ValueError, TypeError):
        return 0.0


def _parse_date(ms) -> datetime:
    try:
        ms = int(ms or 0)
        if ms > 0:
            dt = datetime.fromtimestamp(ms / 1000.0)
            return make_aware(dt)
    except (ValueError, TypeError, OSError):
        pass
    return timezone.now()