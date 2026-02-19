# tasks.py
from celery import shared_task
import logging

# Импортируем модель пользователя и твою готовую функцию
from .models import User
from .bybit_api import sync_bybit_orders

logger = logging.getLogger(__name__)

@shared_task
def sync_bybit_orders_task():
    """
    Фоновая задача для синхронизации P2P ордеров с Bybit.
    Запускает готовую функцию sync_bybit_orders для каждого пользователя.
    """
    # Берем только тех пользователей, у которых заполнены оба ключа Bybit
    users = User.objects.exclude(bybit_api_key__isnull=True).exclude(bybit_api_key__exact='') \
                        .exclude(bybit_api_secret__isnull=True).exclude(bybit_api_secret__exact='')
    
    total_added = 0
    
    for user in users:
        try:
            # Твоя функция уже сама проверяет базу, ищет дубликаты и сохраняет новые
            added_count = sync_bybit_orders(user)
            
            if added_count > 0:
                total_added += added_count
                
        except Exception as e:
            # Если у одного юзера что-то сломалось, ловим ошибку и идем к следующему
            logger.error(f"Ошибка фоновой синхронизации Bybit для {user.username}: {str(e)}")
            
    if total_added > 0:
        logger.info(f"Фоновая синхронизация Bybit завершена. Добавлено новых ордеров (суммарно): {total_added}")
        
    return total_added