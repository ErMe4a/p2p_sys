"""
exchange_api.py

Получение финансовых данных конкретного ордера из API биржи по его ID.
Используется в api_views.py при сохранении ордера через расширение.

Возвращает dict { price, cost, amount, operation_type } или None.

Bybit  — прямой запрос POST /v5/p2p/order/info по orderId
MEXC   — прямой запрос GET /api/v3/fiat/order/detail по advOrderNo
         (ИСПРАВЛЕНО: раньше был постраничный перебор ±1 день —
         оказалось, что есть официальный эндпоинт получения одного
         ордера напрямую по ID, см. официальную доку MEXC P2P API)
Другие — None (HTX, Gate, Telegram берут данные из расширения)
"""

import logging
import hmac
import hashlib
import time
import urllib.parse
import requests
import urllib3
from datetime import datetime, timezone

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

BYBIT_INVALID_KEY_CODES = {33004, 10003, 10004}

# ИСПРАВЛЕНО: добавлен код 700007 — "нет права P2P на ключе" (MEXC обновил
# настройки ключей, у существующих ключей нужно заново включить галочку P2P).
# Раньше этот код падал в "прочие ошибки" и система бесконечно ретраила
# мёртвый ключ вместо того, чтобы сразу его заблокировать.
MEXC_INVALID_KEY_CODES = {10072, 10073, 700007}

MEXC_IP_WHITELIST_CODE = 700006


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

        # Дата создания ордера на бирже — тот же формат (мс-таймстамп в
        # createDate/createTime), что и в пагинации (bybit_api.py). Нужна как
        # надёжный фолбэк, если расширение не смогло распарсить дату со
        # страницы (вёрстка Bybit меняется, парсинг DOM хрупкий).
        created_at = _parse_bybit_date(result.get("createDate") or result.get("createTime"))

        logger.info(
            "Bybit [%s]: order %s — price=%s cost=%s amount=%s type=%s created_at=%s",
            user.username, order_id, price, cost, amount, op, created_at,
        )
        return {
            "price": price, "cost": cost, "amount": amount, "operation_type": op,
            "created_at": created_at,
        }

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
    MEXC P2P: получение данных ордера.

    КРИТИЧНЫЙ ФИКС: эндпоинт GET /api/v3/fiat/order/detail?advOrderNo=...
    возвращает поле "side" ПЕРЕВЁРНУТЫМ относительно реального направления
    сделки — подтверждено на нескольких реальных ордерах: order/detail даёт
    side="BUY" для ордера, который на сайте MEXC и через pagination-эндпоинт
    (/api/v3/fiat/market/order/pagination) однозначно помечен как "Продажа"
    (side="SELL"). price/amount/tradableQuantity в обоих эндпоинтах совпадают
    верно — расходится только "side".

    Поэтому цену/сумму/количество берём из order/detail (один быстрый запрос
    по ID), а тип операции (BUY/SELL) — отдельным запросом к pagination за
    узкое окно времени вокруг даты ордера, где side подтверждённо достоверен.

    Если order_date не передана — используем последние 3 дня для поиска
    в pagination (это чуть медленнее, но затрагивает только "side").
    """
    if not user.mexc_api_key or not user.mexc_api_secret:
        return None
    if not user.mexc_key_valid:
        logger.debug("MEXC [%s]: ключ невалиден, пропускаем.", user.username)
        return None

    try:
        timestamp = int(time.time() * 1000)
        params = {
            "advOrderNo": order_id,
            "timestamp": timestamp,
        }
        query_string = urllib.parse.urlencode(sorted(params.items()))
        sig = hmac.new(
            user.mexc_api_secret.encode("utf-8"),
            query_string.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()

        url = f"https://api.mexc.com/api/v3/fiat/order/detail?{query_string}&signature={sig}"
        headers = {
            "X-MEXC-APIKEY": user.mexc_api_key,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }

        resp = requests.get(url, headers=headers, timeout=15, verify=False)
        data = resp.json()
        code = data.get("code")

        if code in MEXC_INVALID_KEY_CODES:
            user.mexc_key_valid = False
            user.save(update_fields=["mexc_key_valid"])
            if code == 700007:
                logger.warning(
                    "MEXC [%s]: у ключа нет права P2P (код 700007) — помечен невалидным. "
                    "Юзеру нужно включить галочку 'P2P' в настройках ключа на MEXC.",
                    user.username,
                )
            else:
                logger.warning("MEXC [%s]: ключ невалиден (код %s) — помечен.", user.username, code)
            return None

        if code == MEXC_IP_WHITELIST_CODE:
            logger.warning("MEXC [%s]: IP не в whitelist (код 700006).", user.username)
            return None

        if code is not None and code != 0:
            logger.warning(
                "MEXC [%s] order/detail order %s: code=%s msg=%s",
                user.username, order_id, code, data.get("msg"),
            )
            return None

        item = data.get("data") or {}
        if not item:
            logger.warning("MEXC [%s]: order %s не найден.", user.username, order_id)
            return None

        price  = _to_float(item.get("price"))
        amount = _to_float(item.get("tradableQuantity"))
        cost   = _to_float(item.get("amount"))

        if amount == 0 and price > 0 and cost > 0:
            amount = round(cost / price, 8)
        if price == 0 and amount > 0 and cost > 0:
            price = round(cost / amount, 2)

        # ИСПРАВЛЕНО: order/detail отдаёт СВОЮ, авторитетную дату создания
        # (createTime) — используем её для поиска в pagination вместо
        # переданного order_date (который берётся из нашей БД и может быть
        # неверным, например для ордеров, пробитых массово из списка задним
        # числом — там order.created_at = момент пробития, а не реальная
        # дата сделки на бирже, из-за чего окно поиска ±24ч промахивалось
        # мимо ордера и верификация проваливалась навсегда). createTime из
        # order/detail — это то же самое значение, что и в pagination, так
        # что окно вокруг него гарантированно совпадёт.
        created_at = None
        raw_create_time = item.get("createTime")
        if raw_create_time:
            try:
                created_at = datetime.fromtimestamp(int(raw_create_time) / 1000, tz=timezone.utc)
            except (TypeError, ValueError):
                created_at = None

        # ── Тип операции — ОТДЕЛЬНО, через pagination (side из order/detail
        # не используем — он подтверждённо перевёрнут) ──────────────────────
        op = _get_mexc_side_via_pagination(user, order_id, created_at or order_date)
        if op is None:
            # ИСПРАВЛЕНО: раньше тут был fallback на side из order/detail —
            # но именно это поле перевёрнуто, доверять ему нельзя. Если не
            # смогли достоверно определить сторону через pagination — считаем
            # всю верификацию неудачной (вернём None), чтобы вызывающий код
            # ушёл на повторную попытку позже, а не сохранил заведомо рискованный
            # (возможно перевёрнутый) тип операции.
            logger.warning(
                "MEXC [%s]: order %s — не удалось достоверно определить сторону "
                "через pagination, вся верификация провалена (уйдёт на ретрай).",
                user.username, order_id,
            )
            return None

        logger.info(
            "MEXC [%s]: order %s — price=%s cost=%s amount=%s type=%s created_at=%s",
            user.username, order_id, price, cost, amount, op, created_at,
        )
        return {
            "price": price, "cost": cost, "amount": amount, "operation_type": op,
            "created_at": created_at,
        }

    except Exception as e:
        logger.error("MEXC _get_mexc_order [%s] order %s: %s", user.username, order_id, e)
        return None


def _get_mexc_side_via_pagination(user, order_id: str, order_date: datetime = None) -> str | None:
    """
    Достаёт достоверный side для ордера через pagination-эндпоинт.
    Ищет в узком окне вокруг order_date (если передана) или в последних
    3 днях. Возвращает "BUY"/"SELL" или None, если не нашли/ошибка.
    """
    try:
        now_ms = int(time.time() * 1000)

        if order_date:
            if hasattr(order_date, "timestamp"):
                order_ts = int(order_date.timestamp() * 1000)
            else:
                order_ts = now_ms
            start_ms = order_ts - (24 * 60 * 60 * 1000)
            end_ms = min(order_ts + (24 * 60 * 60 * 1000), now_ms)
        else:
            start_ms = now_ms - (3 * 24 * 60 * 60 * 1000)
            end_ms = now_ms

        page = 1
        while page <= 10:  # разумный предел, чтобы не зависнуть
            timestamp = int(time.time() * 1000)
            params = {
                "page": page,
                "limit": 50,
                "startTime": start_ms,
                "endTime": end_ms,
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

            if data.get("code") != 0:
                return None

            items = data.get("data") or []
            for it in items:
                if str(it.get("advOrderNo")) == str(order_id):
                    side = str(it.get("side", "")).upper()
                    return side if side in ("BUY", "SELL") else None

            total_pages = data.get("page", {}).get("totalPage", 1)
            if page >= total_pages or not items:
                break
            page += 1

        return None

    except Exception as e:
        logger.error("MEXC _get_mexc_side_via_pagination [%s] order %s: %s", user.username, order_id, e)
        return None


# ── Пробник для восстановленных ключей ────────────────────────────────────────

def probe_mexc_key(user) -> bool:
    """
    Лёгкая проверка "жив ли ключ снова" — для юзеров с mexc_key_valid=False.

    Используется periodic-таском recheck_mexc_keys_task, который ИГНОРИРУЕТ
    флаг mexc_key_valid специально, чтобы узнать, не включил ли юзер галочку
    P2P заново на том же самом ключе (без пересохранения ключа в системе).

    ИСПРАВЛЕНО: изначально пробник дёргал order/detail с фейковым несуществующим
    ID ("d" + нули). Оказалось, что MEXC на такой запрос иногда возвращает
    недокументированный код 60028 ("User's transaction order error") ДАЖЕ для
    полностью рабочих ключей — это не сигнал о проблеме с правами, а какая-то
    внутренняя особенность именно order/detail на несуществующий ID. Из-за
    этого пробник по order/detail был ненадёжен и мог давать ложные "ключ не
    работает" на реально исправных ключах.

    Теперь используется тот же pagination-эндпоинт, что и в sync_mexc_orders
    (проверен и подтверждён в проде) — запрос за последние 5 минут. Он всегда
    даёт однозначный ответ: code=0 (ключ рабочий, даже если ордеров за этот
    период не было) или code=700007/10072/10073 (ключ реально сломан).

    Возвращает True, если ключ снова рабочий (и сам не трогает флаг —
    это ответственность вызывающего кода, чтобы не размазывать логику
    изменения флага по разным местам).
    """
    if not user.mexc_api_key or not user.mexc_api_secret:
        return False

    try:
        now_ms = int(time.time() * 1000)
        start_ms = now_ms - 5 * 60 * 1000  # последние 5 минут — достаточно для probe

        params = {
            "page": 1,
            "limit": 10,
            "startTime": start_ms,
            "endTime": now_ms,
            "timestamp": now_ms,
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

        if code == 0:
            logger.info("MEXC [%s]: probe успешен — ключ снова рабочий.", user.username)
            return True

        logger.debug("MEXC [%s]: probe — код %s, ключ всё ещё нерабочий.", user.username, code)
        return False

    except Exception as e:
        logger.debug("MEXC [%s]: probe исключение: %s", user.username, e)
        return False


# ── Вспомогательные ───────────────────────────────────────────────────────────

def _to_float(value) -> float:
    try:
        return float(value or 0)
    except (ValueError, TypeError):
        return 0.0


def _parse_bybit_date(ms) -> datetime | None:
    try:
        ms = int(ms or 0)
        if ms > 0:
            return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    except (ValueError, TypeError, OSError):
        pass
    return None