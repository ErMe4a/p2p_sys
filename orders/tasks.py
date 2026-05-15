import logging
from celery import shared_task
from .models import User, Order
from .bybit_api import sync_bybit_orders
from .mexc_api import sync_mexc_orders
from .models import UnprocessedOrder
logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=0, queue="sync")
def sync_bybit_orders_task(self):
    """
    Синхронизирует завершённые ордера Bybit и MEXC для всех пользователей.
    Пишет в UnprocessedOrder.
    Юзеры с невалидными ключами пропускаются.
    """

    bybit_users = (
        User.objects
        .filter(bybit_key_valid=True)
        .exclude(bybit_api_key__isnull=True).exclude(bybit_api_key="")
        .exclude(bybit_api_secret__isnull=True).exclude(bybit_api_secret="")
    )

    bybit_total = 0
    for user in bybit_users:
        try:
            added = sync_bybit_orders(user)
            if added > 0:
                bybit_total += added
                logger.info("Bybit [%s]: +%d новых ордеров.", user.username, added)
        except Exception as e:
            logger.error("Bybit sync error [%s]: %s", user.username, e, exc_info=True)

    mexc_users = (
        User.objects
        .filter(mexc_key_valid=True)
        .exclude(mexc_api_key__isnull=True).exclude(mexc_api_key="")
        .exclude(mexc_api_secret__isnull=True).exclude(mexc_api_secret="")
    )

    mexc_total = 0
    for user in mexc_users:
        try:
            added = sync_mexc_orders(user)
            if added > 0:
                mexc_total += added
                logger.info("MEXC [%s]: +%d новых ордеров.", user.username, added)
        except Exception as e:
            logger.error("MEXC sync error [%s]: %s", user.username, e, exc_info=True)

    logger.info("Sync завершена. Bybit: +%d, MEXC: +%d", bybit_total, mexc_total)
    return {"bybit": bybit_total, "mexc": mexc_total}


@shared_task(bind=True, max_retries=5, queue="receipt")
def verify_and_receipt_later(self, order_id: int):
    """
    Пробует получить данные ордера из API биржи и пробить чек.

    Расписание повторов (нарастающая задержка):
      попытка 1 → через 30 сек  (Bybit) или 120 сек (MEXC)
      попытка 2 → через 60 сек
      попытка 3 → через 120 сек
      попытка 4 → через 240 сек
      попытка 5 → бьём чек с тем что есть в БД
    """
    from .exchange_api import get_order_from_exchange

    try:
        o = Order.objects.get(id=order_id)
    except Order.DoesNotExist:
        logger.warning("verify_and_receipt_later: Order %d не найден.", order_id)
        return

    if o.is_verified:
        logger.info("verify_and_receipt_later: Order %d уже верифицирован.", order_id)
        _try_send_receipt(o)
        return

    if o.receipt and isinstance(o.receipt, dict) and o.receipt.get("uuid"):
        logger.info("verify_and_receipt_later: Order %d чек уже пробит.", order_id)
        return

    attempt = self.request.retries + 1
    logger.info("verify_and_receipt_later: Order %d [%s] попытка %d/5.", order_id, o.external_id, attempt)

    api_data = get_order_from_exchange(
        user=o.user,
        order_id=o.external_id,
        exchange_name=o.exchange_type,
    )

    if api_data:
        if o.is_manual:
            logger.info(
                "verify_and_receipt_later: Order %d — is_manual=True, "
                "данные из API игнорируем, оставляем данные пользователя "
                "price=%s cost=%s amount=%s",
                order_id, o.price, o.cost, o.amount,
            )
            o.is_verified = True
            o.save(update_fields=["is_verified"])
        else:
            o.price          = api_data["price"]
            o.cost           = api_data["cost"]
            o.amount         = api_data["amount"]
            o.operation_type = api_data["operation_type"]
            o.is_verified    = True
            o.save(update_fields=["price", "cost", "amount", "operation_type", "is_verified"])

        UnprocessedOrder.objects.filter(
            user=o.user,
            order_id=o.external_id,
        ).delete()

        logger.info(
            "verify_and_receipt_later: Order %d верифицирован (manual=%s)",
            order_id, o.is_manual,
        )
        _try_send_receipt(o)

    else:
        if attempt < 5:
            countdown = 30 * (2 ** (attempt - 1))
            logger.warning(
                "verify_and_receipt_later: Order %d — API не ответил, повтор через %d сек.",
                order_id, countdown,
            )
            raise self.retry(countdown=countdown)
        else:
            logger.warning(
                "verify_and_receipt_later: Order %d — 5 попыток исчерпаны, бьём чек с данными из БД.",
                order_id,
            )
            _try_send_receipt(o)


def _try_send_receipt(order: Order):
    """
    Пробивает чек если есть contact и ненулевая сумма.
    Чек уже пробитый не трогаем.
    """
    from .receipt_service import create_or_update_and_send_receipt

    if order.receipt and isinstance(order.receipt, dict) and order.receipt.get("uuid"):
        return

    receipt_dict = order.receipt if isinstance(order.receipt, dict) else {}
    contact = receipt_dict.get("contact")

    if not contact:
        logger.debug("_try_send_receipt: Order %d — нет contact, чек не нужен.", order.id)
        return

    if not order.cost or float(order.cost) == 0:
        logger.warning("_try_send_receipt: Order %d — нулевая сумма, чек не бьём.", order.id)
        return

    # ── ИСПРАВЛЕНИЕ ──────────────────────────────────────────────────────────
    # Берём финансовые данные из верифицированного ордера (API данные),
    # а не из плашки расширения где курс мог прийти в копейках (79950 вместо 79.95).
    # contact берём из receipt_dict — его в API нет.
    if order.is_verified:
        receipt_dict = {
            **receipt_dict,
            "price":  float(order.price),
            "sum":    float(order.cost),
            "amount": float(order.amount),
        }
        logger.info(
            "_try_send_receipt: Order %d — подменяем данные чека из ордера: "
            "price=%s sum=%s amount=%s",
            order.id, float(order.price), float(order.cost), float(order.amount),
        )

    try:
        result = create_or_update_and_send_receipt(order, receipt_dict)
        logger.info(
            "_try_send_receipt: Order %d — чек отправлен, статус=%s uuid=%s",
            order.id,
            getattr(result, "status", None),
            getattr(result, "evotor_uuid", None),
        )
    except Exception as e:
        logger.error("_try_send_receipt: Order %d — ошибка: %s", order.id, e)