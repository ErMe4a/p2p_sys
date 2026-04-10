import logging
from datetime import datetime
from django.utils import timezone
from django.utils.timezone import make_aware
from bybit_p2p import P2P
from .models import UnprocessedOrder, Order, IgnoredOrder

logger = logging.getLogger(__name__)

# Тянем ордера только начиная с этой даты
DATE_FROM_MS = int(datetime(2026, 2, 24).timestamp() * 1000)

# Все коды Bybit которые означают проблему с ключом
# 33004 — api key has expired
# 10003 — api key is invalid
# 10004 — error sign / signature (неверный секрет)
BYBIT_INVALID_KEY_CODES = {33004, 10003, 10004}


def _mark_invalid(user, code, source="ret_code"):
    """Помечает ключ невалидным и логирует."""
    user.bybit_key_valid = False
    user.save(update_fields=["bybit_key_valid"])
    logger.warning(
        "Bybit [%s]: ключ невалиден (%s=%s) — помечен, следующие циклы будут пропущены.",
        user.username, source, code,
    )


def sync_bybit_orders(user):
    """
    Синхронизация ЗАВЕРШЁННЫХ P2P ордеров Bybit (status=50).
    Возвращает количество добавленных ордеров (int).
    """

    # ── 1. Проверка ключей ────────────────────────────────────────────────────
    if not user.bybit_api_key or not user.bybit_api_secret:
        logger.debug("User %s: Bybit keys not set, skipping.", user.username)
        return 0

    if not user.bybit_key_valid:
        logger.debug("Bybit [%s]: ключ помечен невалидным — пропускаем.", user.username)
        return 0

    # ── 2. Инициализация клиента ──────────────────────────────────────────────
    try:
        api = P2P(
            testnet=False,
            api_key=user.bybit_api_key,
            api_secret=user.bybit_api_secret,
        )
    except Exception as e:
        logger.error("Bybit Init Error for %s: %s", user.username, e)
        return 0

    # ── 3. Собираем «чёрный список» уже известных ID ─────────────────────────
    processed_ids = set(
        Order.objects.filter(user=user)
        .exclude(external_id="")
        .exclude(external_id__isnull=True)
        .values_list("external_id", flat=True)
    )
    unprocessed_ids = set(
        UnprocessedOrder.objects.filter(user=user)
        .values_list("order_id", flat=True)
    )
    ignored_ids = set(
        IgnoredOrder.objects.filter(user=user)
        .values_list("order_id", flat=True)
    )
    ignore_ids = processed_ids | unprocessed_ids | ignored_ids

    # ── 4. Постраничная выгрузка с Bybit ─────────────────────────────────────
    raw_items = []
    page = 1

    while True:
        try:
            response = api.get_orders(
                page=page,
                size=30,
                status=50,
            )
        except Exception as e:
            err_str = str(e)
            # Библиотека bybit_p2p кидает exception раньше чем мы видим ret_code
            # Проверяем все известные коды невалидных ключей в тексте ошибки
            matched_code = next(
                (code for code in BYBIT_INVALID_KEY_CODES if str(code) in err_str),
                None
            )
            if matched_code or "api key" in err_str.lower() or "sign" in err_str.lower():
                _mark_invalid(user, matched_code or "exception", source="exception")
                return 0
            logger.error("Bybit get_orders page=%d for %s: %s", page, user.username, e)
            break

        ret_code = response.get("ret_code")
        if ret_code is None:
            ret_code = response.get("retCode")

        if ret_code != 0:
            ret_msg = response.get("ret_msg") or response.get("retMsg") or ""

            # Проверяем числовой код
            if ret_code in BYBIT_INVALID_KEY_CODES:
                _mark_invalid(user, ret_code)
                return 0

            # Дополнительная проверка по тексту ошибки
            ret_msg_lower = str(ret_msg).lower()
            if any(kw in ret_msg_lower for kw in ["api key", "invalid key", "sign", "expired"]):
                _mark_invalid(user, ret_code, source="ret_msg")
                return 0

            logger.warning(
                "Bybit API error for %s (code %s): %s",
                user.username, ret_code, ret_msg,
            )
            break

        items = (
            response.get("result", {}).get("items")
            or response.get("result", {}).get("list")
            or []
        )

        if not items:
            break

        raw_items.extend(items)
        logger.debug("Bybit [%s] page %d: got %d items", user.username, page, len(items))

        last_item_ms = int(
            items[-1].get("createDate") or items[-1].get("createTime") or 0
        )

        if len(items) < 30 or last_item_ms < DATE_FROM_MS:
            break

        page += 1

    if not raw_items:
        logger.debug("Bybit [%s]: no items from API.", user.username)
        return 0

    # ── 5. Парсим, фильтруем, формируем объекты ───────────────────────────────
    new_orders = []
    seen_in_batch = set()

    for item in raw_items:
        created_ms = int(
            item.get("createDate") or item.get("createTime") or 0
        )
        if created_ms < DATE_FROM_MS:
            continue

        bybit_id = str(
            item.get("id") or item.get("orderId") or ""
        ).strip()

        if not bybit_id:
            continue
        if bybit_id in ignore_ids:
            continue
        if bybit_id in seen_in_batch:
            continue

        seen_in_batch.add(bybit_id)
        ignore_ids.add(bybit_id)

        operation_type = "SELL" if str(item.get("side")) == "1" else "BUY"

        price         = _to_float(item.get("price"))
        crypto_amount = _to_float(
            item.get("notifyTokenQuantity") or item.get("quantity")
        )
        fiat_amount   = _to_float(item.get("amount"))

        if crypto_amount == 0 and price > 0 and fiat_amount > 0:
            crypto_amount = round(fiat_amount / price, 8)

        aware_dt = _parse_date(created_ms)

        new_orders.append(
            UnprocessedOrder(
                user=user,
                order_id=bybit_id,
                operation_type=operation_type,
                amount=crypto_amount,
                price=price,
                cost=fiat_amount,
                exchange_type="Bybit",
                created_at=aware_dt,
            )
        )

    # ── 6. Массовое сохранение ────────────────────────────────────────────────
    if new_orders:
        UnprocessedOrder.objects.bulk_create(new_orders, ignore_conflicts=True)
        logger.info("Bybit [%s]: saved %d new orders.", user.username, len(new_orders))

    return len(new_orders)


# ── Вспомогательные функции ───────────────────────────────────────────────────

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