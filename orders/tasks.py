import logging
from celery import shared_task
from .models import User
from .bybit_api import sync_bybit_orders

logger = logging.getLogger(__name__)

@shared_task(bind=True, max_retries=0)
def sync_bybit_orders_task(self):
    users = (
        User.objects
        .exclude(bybit_api_key__isnull=True).exclude(bybit_api_key="")
        .exclude(bybit_api_secret__isnull=True).exclude(bybit_api_secret="")
    )
    total_added = 0
    for user in users:
        try:
            added = sync_bybit_orders(user)
            if added > 0:
                total_added += added
                logger.info("Bybit [%s]: +%d новых ордеров.", user.username, added)
        except Exception as e:
            logger.error("Bybit sync error [%s]: %s", user.username, e, exc_info=True)
    return total_added