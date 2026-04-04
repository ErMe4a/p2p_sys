import logging
from celery import shared_task
from .models import User
from .bybit_api import sync_bybit_orders
from .mexc_api import sync_mexc_orders

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=0)
def sync_bybit_orders_task(self):
    """
    Запускается Celery Beat каждые 3 минуты.
    Синхронизирует завершённые ордера Bybit и MEXC для всех пользователей.
    Юзеры с невалидными ключами (bybit_key_valid=False / mexc_key_valid=False)
    пропускаются — они помечаются автоматически при получении ошибки от биржи.
    """

    # ── Bybit ─────────────────────────────────────────────────────────────────
    bybit_users = (
        User.objects
        .filter(bybit_key_valid=True)                        # ← только валидные
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

    # ── MEXC ──────────────────────────────────────────────────────────────────
    mexc_users = (
        User.objects
        .filter(mexc_key_valid=True)                         # ← только валидные
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

    logger.info(
        "Sync завершена. Bybit: +%d, MEXC: +%d",
        bybit_total, mexc_total
    )
    return {"bybit": bybit_total, "mexc": mexc_total}