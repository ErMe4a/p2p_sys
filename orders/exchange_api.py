"""
exchange_api.py

Получение финансовых данных конкретного ордера из API биржи по его ID.
Используется в api_views.py при сохранении ордера через расширение.

Возвращает dict { price, cost, amount, operation_type } или None.

Bybit  — прямой запрос POST /v5/p2p/order/info по orderId
MEXC   — поиск в UnprocessedOrder (нет API-эндпоинта по одному ID)
Другие — None (HTX, Gate, Telegram берут данные из расширения)
"""

import logging
logger = logging.getLogger(__name__)

# Все коды Bybit которые означают проблему с ключом
BYBIT_INVALID_KEY_CODES = {33004, 10003, 10004}


def get_order_from_exchange(user, order_id: str, exchange_name: str) -> dict | None:
    ex = exchange_name.lower()
    if "bybit" in ex:
        return _get_bybit_order(user, order_id)
    if "mexc" in ex:
        return _get_mexc_order(user, order_id)
    logger.debug("exchange_api: биржа %s — прямой запрос не поддерживается.", exchange_name)
    return None


def _mark_bybit_invalid(user, code, source="ret_code"):
    user.bybit_key_valid = False
    user.save(update_fields=["bybit_key_valid"])
    logger.warning(
        "Bybit [%s]: ключ невалиден (%s=%s) при get_order_details — помечен.",
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


def _get_mexc_order(user, order_id: str) -> dict | None:
    if not user.mexc_api_key or not user.mexc_api_secret:
        return None
    if not user.mexc_key_valid:
        logger.debug("MEXC [%s]: ключ невалиден, пропускаем.", user.username)
        return None

    try:
        from .models import UnprocessedOrder
        cached = UnprocessedOrder.objects.filter(
            user=user,
            order_id=order_id,
            exchange_type="MEXC",
        ).first()

        if cached:
            logger.info("MEXC [%s]: order %s найден в UnprocessedOrder.", user.username, order_id)
            return {
                "price":          float(cached.price),
                "cost":           float(cached.cost),
                "amount":         float(cached.amount),
                "operation_type": cached.operation_type,
            }

        logger.warning(
            "MEXC [%s]: order %s не найден в UnprocessedOrder — "
            "verify_and_receipt_later повторит через 120 сек.",
            user.username, order_id,
        )
        return None

    except Exception as e:
        logger.error("MEXC _get_mexc_order [%s] order %s: %s", user.username, order_id, e)
        return None


def _to_float(value) -> float:
    try:
        return float(value or 0)
    except (ValueError, TypeError):
        return 0.0