import hmac
import hashlib
import time
import logging
import requests
import urllib3
from datetime import datetime
from django.utils import timezone
from django.utils.timezone import make_aware
from .models import UnprocessedOrder, Order, IgnoredOrder

# Отключаем предупреждения о SSL
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

# Тянем ордера только начиная с этой даты (24.02.2026)
DATE_FROM_MS = int(datetime(2026, 2, 24).timestamp() * 1000)

BASE_URL = "https://api.mexc.com"

# Статусы MEXC которые считаются отменёнными — такие ордера не берём
MEXC_CANCELLED_STATES = {"CANCEL", "CANCELLED", "CANCELED", "APPEAL_CANCEL", "APPEAL_CANCELLED"}

# Коды ошибок MEXC которые означают что ключ невалиден навсегда
# 10072 = Api key info invalid
# 10073 = Api key not exists
MEXC_INVALID_KEY_CODES = {10072, 10073}

# Код ошибки MEXC для IP не в whitelist — ключ сам по себе валиден,
# просто нужно убрать IP-ограничение в настройках ключа на MEXC
MEXC_IP_WHITELIST_CODE = 700006


def sync_mexc_orders(user):
    """
    Синхронизация ЗАВЕРШЁННЫХ P2P ордеров MEXC (orderDealState=DONE).

    Алгоритм:
      1. Проверяем ключи — если нет или помечены невалидными, выходим.
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

    # ── НОВОЕ: пропускаем юзеров с помеченными невалидными ключами ───────────
    if not user.mexc_key_valid:
        logger.debug(
            "MEXC [%s]: ключ помечен невалидным — пропускаем.",
            user.username,
        )
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
        data, error_code, error_msg = _fetch_page(user, page, DATE_FROM_MS, end_time)

        if error_code is not None:
            # ── НОВОЕ: невалидный ключ — помечаем и выходим ──────────────────
            if error_code in MEXC_INVALID_KEY_CODES:
                user.mexc_key_valid = False
                user.save(update_fields=["mexc_key_valid"])
                logger.warning(
                    "MEXC [%s]: ключ невалиден (код %s) — "
                    "помечен невалидным, следующие циклы будут пропущены.",
                    user.username,
                    error_code,
                )
                return 0

            # ── НОВОЕ: IP не в whitelist — не трогаем флаг, просто логируем ─
            if error_code == MEXC_IP_WHITELIST_CODE:
                logger.warning(
                    "MEXC [%s]: IP сервера не в whitelist ключа (код 700006). "
                    "Попросите пользователя убрать IP-ограничение в настройках "
                    "API ключа на MEXC (или добавить IP 89.169.143.100).",
                    user.username,
                )
                return 0

            # Прочие ошибки — логируем и выходим
            logger.error("MEXC API error for %s: code=%s msg=%s", user.username, error_code, error_msg)
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

    # ── 6. Самоисправление гонки ──────────────────────────────────────────────
    # processed_ids (шаг 2) — снимок НА МОМЕНТ НАЧАЛА синка. Пока мы тут
    # постранично тянули ордера с биржи, юзер мог успеть провести и
    # зафискализировать этот же ордер через расширение — тогда единственное
    # штатное удаление из UnprocessedOrder (api_views.py/tasks.py, сразу
    # после верификации) уже отработало на ещё не существующей строке, а мы
    # только что вставили её заново. Подчищаем такие "призраки" при каждом
    # синке — заодно лечится и то, что уже накопилось раньше.
    stale_ids = (
        set(
            Order.objects.filter(user=user, exchange_type="MEXC")
            .exclude(external_id="").exclude(external_id__isnull=True)
            .values_list("external_id", flat=True)
        )
        & set(
            UnprocessedOrder.objects.filter(user=user, exchange_type="MEXC")
            .values_list("order_id", flat=True)
        )
    )
    if stale_ids:
        deleted, _ = UnprocessedOrder.objects.filter(
            user=user, exchange_type="MEXC", order_id__in=stale_ids
        ).delete()
        logger.info("MEXC [%s]: подчищено %d гонок в Необработанных.", user.username, deleted)

    return len(new_orders)


# ── Вспомогательные функции ───────────────────────────────────────────────────

def _fetch_page(user, page: int, start_time: int, end_time: int):
    """
    Запрашивает одну страницу ордеров с MEXC.
    Возвращает (data, error_code, error_message).
    При успехе: (data, None, None)
    При ошибке: (None, code, message)
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

        code = data.get("code")
        if code != 0:
            return None, code, data.get("msg")

        return data, None, None

    except Exception as e:
        return None, None, str(e)


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