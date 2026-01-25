# orders/receipt_service.py
from .models import Order
# Убрали импорт Receipt, так как модели больше нет
from .evotor_atol import (
    evotor_get_token,
    evotor_register_receipt,
    build_receipt_payload_v5,
    EvotorAtolError,
)

# Простой класс для ответа (вместо модели БД)
class ReceiptResponse:
    def __init__(self, status="PENDING", error_text="", evotor_uuid=None):
        self.status = status
        self.error_text = error_text
        self.evotor_uuid = evotor_uuid

def _bool(v) -> bool:
    """Превращает строку/число/bool в чистый bool"""
    if isinstance(v, bool): return v
    if v is None: return False
    return str(v).strip().lower() in ("1", "true", "yes", "on")

def should_make_receipt(data: dict) -> bool:
    """Проверяем, нужно ли бить чек"""
    if not isinstance(data, dict): return False
    
    # 1. Сначала смотрим на явный флаг из расширения (то, что мы добавили в JS)
    if _bool(data.get("hasReceipt")): 
        return True
    
    # 2. Если флага нет, смотрим на косвенные признаки (на всякий случай)
    receipt = data.get("receipt")
    if isinstance(receipt, dict):
        if receipt.get("contact") or receipt.get("sum"):
            return True
            
    return False

def get_evotor_operation_type(order: Order) -> str:
    """Маппинг операций Django -> Эвотор API"""
    if order.operation_type == 'SELL':
        return 'sell'  # Приход
    elif order.operation_type == 'BUY':
        return 'buy'   # Расход
    return 'sell'

def create_or_update_and_send_receipt(order, receipt_data: dict) -> ReceiptResponse:
    """
    Отправка чека в Эвотор БЕЗ сохранения в БД.
    Возвращает объект ReceiptResponse с результатами.
    """
    user = order.user

    # 1. Валидация реквизитов пользователя
    required_fields = [
        user.evotor_login, user.evotor_password, 
        user.kkt_id, user.inn, user.payment_address
    ]
    
    if not all(required_fields):
        return ReceiptResponse(
            status="ERROR", 
            error_text="Не заполнены настройки Эвотор (Логин, Пароль, ККТ, ИНН, Адрес)"
        )

    try:
        # 2. Авторизация (получаем токен)
        token = evotor_get_token(user.evotor_login, user.evotor_password)

        # 3. Определяем тип операции (sell/buy)
        operation_type = get_evotor_operation_type(order)

        # 4. Собираем JSON
        payload = build_receipt_payload_v5(
            order=order,
            user=user,
            receipt_data=receipt_data or {},
            check_type=operation_type
        )

        # 5. Отправка запроса в Эвотор
        response_data = evotor_register_receipt(
            token=token,
            group_code=user.kkt_id,
            operation=operation_type,
            payload=payload
        )

        # 6. Успех
        return ReceiptResponse(
            status="SENT", 
            evotor_uuid=response_data.get("uuid"),
            error_text=""
        )

    except EvotorAtolError as e:
        # Ошибка логики (неверный токен, валидация JSON)
        return ReceiptResponse(status="ERROR", error_text=str(e))
        
    except Exception as e:
        # Непредвиденная ошибка системы
        return ReceiptResponse(status="ERROR", error_text=f"System Error: {str(e)}")