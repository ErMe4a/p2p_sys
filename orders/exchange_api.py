"""
exchange_api.py

Получение финансовых данных конкретного ордера из API биржи по его ID.
Используется в api_views.py при сохранении ордера через расширение.

Возвращает dict { price, cost, amount, operation_type } или None.

Bybit  — прямой запрос POST /v5/p2p/order/info по orderId
MEXC   — постраничный запрос в диапазоне ±1 день от даты ордера
Другие — None (HTX, Gate, Telegram берут данные из расширения)
"""

import logging
import hmac
import hashlib
import time
import requests
import urllib3
from datetime import datetime, timezone

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

BYBIT_INVALID_KEY_CODES = {33004, 10003, 10004}
MEXC_INVALID_KEY_CODES  = {10072, 10073}


def get_order_from_exchange(
    user,
    order_id: str,
    exchange_name: str,
    order_date: datetime = None,
) -> dict | None:
    ex = exchange_name.lower()
    if "bybit" in ex:
        return _get_bybit_order(user, order_id)
    if "mexc" in ex:
        return _get_mexc_order(user, order_id, order_date)
    logger.debug("exchange_api: биржа %s — прямой запрос не поддерживается.", exchange_name)
    return None


# ── Bybit ─────────────────────────────────────────────────────────────────────

def _mark_bybit_invalid(user, code, source="ret_code"):
    user.bybit_key_valid = False
    user.save(update_fields=["bybit_key_valid"])
    logger.warning(
        "Bybit [%s]: ключ невалиден (%s=%s) — помечен.",
        user.username, source, code,
    )


def _get_bybit_order(user, order_id: str) -> dict | None:
    if not user.bybit_api_key or not user.bybit_api_secret:
        return None
    if not user.bybit_key_valid:
        logger.debug("Bybit [%s]: ключ невалиден, пропускаем.", user.username)
        return None

    try:
        from bybit_p2p import P2P
        api = P2P(
            testnet=False,
            api_key=user.bybit_api_key,
            api_secret=user.bybit_api_secret,
        )
        response = api.get_order_details(orderId=order_id)

        ret_code = response.get("ret_code")
        if ret_code is None:
            ret_code = response.get("retCode")

        if ret_code != 0:
            ret_msg = response.get("ret_msg") or response.get("retMsg") or ""
            if ret_code in BYBIT_INVALID_KEY_CODES or "api key" in str(ret_msg).lower():
                _mark_bybit_invalid(user, ret_code)
            else:
                logger.warning(
                    "Bybit get_order_details [%s] order %s: code=%s msg=%s",
                    user.username, order_id, ret_code, ret_msg,
                )
            return None

        result = response.get("result") or {}
        price  = _to_float(result.get("price"))
        amount = _to_float(result.get("quantity") or result.get("notifyTokenQuantity"))
        cost   = _to_float(result.get("amount"))
        op     = "SELL" if str(result.get("side", "0")) == "1" else "BUY"

        if price == 0 and cost > 0 and amount > 0:
            price = round(cost / amount, 2)
        if amount == 0 and price > 0 and cost > 0:
            amount = round(cost / price, 8)

        logger.info(
            "Bybit [%s]: order %s — price=%s cost=%s amount=%s type=%s",
            user.username, order_id, price, cost, amount, op,
        )
        return {"price": price, "cost": cost, "amount": amount, "operation_type": op}

    except Exception as e:
        err_str = str(e)
        matched = next((c for c in BYBIT_INVALID_KEY_CODES if str(c) in err_str), None)
        if matched or "api key" in err_str.lower() or "sign" in err_str.lower():
            _mark_bybit_invalid(user, matched or "exception", source="exception")
        else:
            logger.error("Bybit get_order_details [%s] order %s: %s", user.username, order_id, e)
        return None


# ── MEXC ──────────────────────────────────────────────────────────────────────

def _get_mexc_order(user, order_id: str, order_date: datetime = None) -> dict | None:
    """
    MEXC P2P: нет эндпоинта по одному ID.
    Листаем страницы в диапазоне ±1 день от даты ордера пока не найдём.
    Если дата не передана — берём последние 3 дня.
    """
    if not user.mexc_api_key or not user.mexc_api_secret:
        return None
    if not user.mexc_key_valid:
        logger.debug("MEXC [%s]: ключ невалиден, пропускаем.", user.username)
        return None

    try:
        now_ms = int(time.time() * 1000)

        # Определяем диапазон поиска
        if order_date:
            # Берём ±1 день от даты ордера на бирже
            if hasattr(order_date, 'timestamp'):
                order_ts = int(order_date.timestamp() * 1000)
            else:
                order_ts = now_ms
            start_time = order_ts - (24 * 60 * 60 * 1000)
            end_time   = order_ts + (24 * 60 * 60 * 1000)
            # Не заглядываем в будущее
            if end_time > now_ms:
                end_time = now_ms
        else:
            # Дата не передана — ищем в последних 3 днях
            start_time = now_ms - (3 * 24 * 60 * 60 * 1000)
            end_time   = now_ms

        # Листаем страницы пока не найдём или не закончатся
        page = 1
        while True:
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
            sig = hmac.new(
                user.mexc_api_secret.encode("utf-8"),
                query_string.encode("utf-8"),
                hashlib.sha256
            ).hexdigest()

            url = f"https://api.mexc.com/api/v3/fiat/market/order/pagination?{query_string}&signature={sig}"
            headers = {
                "X-MEXC-APIKEY": user.mexc_api_key,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            }

            resp = requests.get(url, headers=headers, timeout=15, verify=False)
            data = resp.json()
            code = data.get("code")

            # Невалидный ключ
            if code in MEXC_INVALID_KEY_CODES:
                user.mexc_key_valid = False
                user.save(update_fields=["mexc_key_valid"])
                logger.warning("MEXC [%s]: ключ невалиден (код %s) — помечен.", user.username, code)
                return None

            # IP whitelist
            if code == 700006:
                logger.warning("MEXC [%s]: IP не в whitelist (код 700006).", user.username)
                return None

            if code is not None and code != 0:
                logger.warning("MEXC [%s] page %d: code=%s msg=%s", user.username, page, code, data.get("msg"))
                return None

            items = data.get("data") or []

            # Ищем нужный ордер на этой странице
            for item in items:
                if str(item.get("advOrderNo")) == str(order_id):
                    price  = _to_float(item.get("price"))
                    amount = _to_float(item.get("tradableQuantity"))
                    cost   = _to_float(item.get("amount"))
                    op     = str(item.get("side", "BUY")).upper()

                    if amount == 0 and price > 0 and cost > 0:
                        amount = round(cost / price, 8)
                    if price == 0 and amount > 0 and cost > 0:
                        price = round(cost / amount, 2)

                    logger.info(
                        "MEXC [%s]: order %s найден на стр.%d — price=%s cost=%s amount=%s type=%s",
                        user.username, order_id, page, price, cost, amount, op,
                    )
                    return {"price": price, "cost": cost, "amount": amount, "operation_type": op}

            # Проверяем есть ли следующая страница
            total_pages = data.get("page", {}).get("totalPage", 1)
            if page >= total_pages or not items:
                break
            page += 1

        logger.warning(
            "MEXC [%s]: order %s не найден в диапазоне дат (проверено %d стр.).",
            user.username, order_id, page,
        )
        return None

    except Exception as e:
        logger.error("MEXC _get_mexc_order [%s] order %s: %s", user.username, order_id, e)
        return None


# ── Вспомогательные ───────────────────────────────────────────────────────────

def _to_float(value) -> float:
    try:
        return float(value or 0)
    except (ValueError, TypeError):
        return 0.0