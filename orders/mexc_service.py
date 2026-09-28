import hmac
import hashlib
import time
import requests
import concurrent.futures
from datetime import datetime, timedelta
from django.utils.timezone import make_aware

# Тот же набор "отменённых" статусов, что и в персистентном синк-пути
# (mexc_api.py) — чтобы не показывать отменённые сделки как реальные.
MEXC_CANCELLED_STATES = {"CANCEL", "CANCELLED", "CANCELED", "APPEAL_CANCEL", "APPEAL_CANCELLED"}


class DisplayOrder:
    """
    Класс-заглушка для отображения данных в шаблоне.
    """
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def _fetch_single_user_mexc(user, time_threshold_ms):
    """
    Логика получения ордеров MEXC для одного пользователя за последние 24 часа.

    Эндпоинт и маппинг полей ответа - те же, что уже реально используются в
    персистентном синк-пути (mexc_api.py._fetch_page/sync_mexc_orders) для
    получения ордеров, которые потом верифицируются и фискализируются -
    /api/v3/fiat/orders (использовавшийся здесь раньше) не существует у MEXC
    вообще (404), поэтому эта live-статистика всегда молча показывала 0 ордеров.
    """
    if not user.mexc_api_key or len(str(user.mexc_api_key)) < 5:
        return []
    if not user.mexc_api_secret or len(str(user.mexc_api_secret)) < 5:
        return []

    orders_buffer = []
    base_url = "https://api.mexc.com"
    endpoint = "/api/v3/fiat/market/order/pagination"

    try:
        now_ms = int(time.time() * 1000)
        params = {
            "orderDealState": "DONE",
            "page": 1,
            "limit": 100,
            "startTime": time_threshold_ms,
            "endTime": now_ms,
            "timestamp": now_ms,
        }

        # Строка подписи строится ТАК ЖЕ, как в mexc_api.py - простой join,
        # не urlencode (MEXC сверяет подпись побайтово с этой же строкой,
        # которая затем идёт в URL как есть).
        query_string = "&".join(f"{k}={v}" for k, v in params.items())
        signature = hmac.new(
            user.mexc_api_secret.encode("utf-8"),
            query_string.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        url = f"{base_url}{endpoint}?{query_string}&signature={signature}"
        headers = {
            "X-MEXC-APIKEY": user.mexc_api_key,
            "Content-Type": "application/json",
        }

        response = requests.get(url, headers=headers, timeout=10)
        data = response.json()

        if data.get("code") not in (0, None):
            return []

        items = data.get("data") or []

        for item in items:
            created_ms = int(item.get("createTime") or 0)
            if created_ms < time_threshold_ms:
                continue

            deal_state = (
                item.get("orderDealState")
                or item.get("dealState")
                or item.get("state")
                or item.get("status")
                or ""
            )
            if str(deal_state).upper() in MEXC_CANCELLED_STATES:
                continue

            order_id = str(item.get("advOrderNo") or "").strip()
            if not order_id:
                continue

            operation_type = str(item.get("side", "BUY")).upper()

            price = float(item.get("price") or 0)
            crypto_amount = float(item.get("tradableQuantity") or 0)
            fiat_amount = float(item.get("amount") or 0)

            if crypto_amount == 0 and price > 0 and fiat_amount > 0:
                crypto_amount = round(fiat_amount / price, 8)

            try:
                dt = datetime.fromtimestamp(created_ms / 1000.0)
                aware_dt = make_aware(dt)
            except Exception:
                aware_dt = datetime.now()

            orders_buffer.append(DisplayOrder(
                external_id=order_id,
                user=user,
                exchange_type="MEXC",
                operation_type=operation_type,
                amount=crypto_amount,
                price=price,
                cost=fiat_amount,
                created_at=aware_dt,
                status_raw=str(deal_state),
                bank_detail={'name': 'P2P API'},
            ))

    except Exception:
        pass

    return orders_buffer


def get_mexc_orders_parallel(users_queryset, filters=None):
    """
    Запускает параллельный опрос пользователей для MEXC.
    """
    all_orders = []

    # Порог времени: 24 часа назад в мс
    time_threshold = datetime.now() - timedelta(hours=24)
    time_threshold_ms = int(time_threshold.timestamp() * 1000)

    # 10 потоков
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_user = {
            executor.submit(_fetch_single_user_mexc, user, time_threshold_ms): user
            for user in users_queryset
        }

        for future in concurrent.futures.as_completed(future_to_user):
            try:
                data = future.result()
                all_orders.extend(data)
            except Exception:
                continue

    # Фильтрация
    if filters:
        if filters.get('type'):
            all_orders = [x for x in all_orders if x.operation_type == filters['type']]

        # Если запросили НЕ MEXC (и не "Все"), очищаем список
        if filters.get('exchange'):
            req_exch = filters['exchange']
            if req_exch not in ('MEXC', '2', ''):
                all_orders = []

    all_orders.sort(key=lambda x: x.created_at, reverse=True)
    return all_orders
