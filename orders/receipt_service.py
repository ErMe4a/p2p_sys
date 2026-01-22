# orders/receipt_service.py
from decimal import Decimal
from django.utils import timezone
from .models import Receipt, Order
from .evotor_atol import (
    evotor_get_token,
    evotor_register_receipt,
    build_receipt_payload_v5,
    EvotorAtolError,
)

def _bool(v) -> bool:
    if isinstance(v, bool): return v
    if v is None: return False
    return str(v).strip().lower() in ("1", "true", "yes", "on")

def should_make_receipt(data: dict) -> bool:
    """Проверяем, нужно ли бить чек"""
    if not isinstance(data, dict): return False
    # Проверка явного флага (если есть чекбокс)
    if _bool(data.get("hasReceipt")): return True
    
    # Проверка наличия данных чека
    receipt = data.get("receipt")
    if isinstance(receipt, dict):
        # Если заполнен контакт или сумма - значит юзер хочет чек
        if receipt.get("contact") or receipt.get("sum"):
            return True
    return False

def get_evotor_operation_type(order: Order) -> str:
    """
    Маппинг операций Django -> Эвотор API
    
    Логика P2P:
    1. Мы ПРОДАЕМ крипту (SELL) -> Клиент переводит нам рубли -> Это ПРИХОД денег -> 'sell'
    2. Мы ПОКУПАЕМ крипту (BUY) -> Мы переводим клиенту рубли -> Это РАСХОД денег -> 'buy'
    """
    if order.operation_type == 'SELL':
        return 'sell'  # Приход
    elif order.operation_type == 'BUY':
        return 'buy'   # Расход
    
    # Дефолтное значение, если что-то пошло не так
    return 'sell'

def create_or_update_and_send_receipt(order, receipt_data: dict):
    """
    Основная функция: создание записи Receipt и отправка в Эвотор
    """
    # 1. Создаем или получаем объект Receipt в БД
    receipt_obj, created = Receipt.objects.get_or_create(order=order)

    # Если чек уже пробит или в процессе - не трогаем (идемпотентность)
    if receipt_obj.status in ["DONE", "SENT"]:
        return receipt_obj

    user = order.user

    # 2. Валидация реквизитов пользователя
    required_fields = [
        user.evotor_login, user.evotor_password, 
        user.kkt_id, user.inn, user.payment_address
    ]
    if not all(required_fields):
        receipt_obj.status = "ERROR"
        receipt_obj.error_text = "Не заполнены настройки Эвотор (Логин, Пароль, ККТ, ИНН, Адрес)"
        receipt_obj.save()
        return receipt_obj

    try:
        # 3. Авторизация (получаем токен)
        token = evotor_get_token(user.evotor_login, user.evotor_password)

        # 4. Определяем тип операции (sell/buy)
        operation_type = get_evotor_operation_type(order)

        # 5. Собираем JSON по схеме v5
        # Передаем receipt_data, так как там могут быть свежие данные из формы (контакт, точная сумма)
        # Если receipt_data пустое, билдер возьмет данные из order
        payload = build_receipt_payload_v5(
            order=order,
            user=user,
            receipt_data=receipt_data or {},
            check_type=operation_type
        )

        # 6. Отправка запроса
        response_data = evotor_register_receipt(
            token=token,
            group_code=user.kkt_id,
            operation=operation_type,
            payload=payload
        )

        # 7. Успех
        receipt_obj.status = "SENT" # Отправлен, ждем обработки (wait)
        receipt_obj.evotor_uuid = response_data.get("uuid")
        receipt_obj.request_payload = payload
        receipt_obj.response_payload = response_data
        receipt_obj.error_text = ""
        receipt_obj.save()

    except EvotorAtolError as e:
        # Ошибка логики (неверный токен, валидация JSON)
        receipt_obj.status = "ERROR"
        receipt_obj.error_text = str(e)
        receipt_obj.save()
    except Exception as e:
        # Непредвиденная ошибка
        receipt_obj.status = "ERROR"
        receipt_obj.error_text = f"System Error: {str(e)}"
        receipt_obj.save()
    
    return receipt_obj