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

# receipt_service.py

def create_or_update_and_send_receipt(order, receipt_data: dict) -> ReceiptResponse:
    """
    Отправка чека в Эвотор И СОХРАНЕНИЕ результата в БД.
    """
    user = order.user

    # 1. Если чек уже есть в базе, не бьем повторно (защита)
    if order.receipt and order.receipt.get("uuid"):
         return ReceiptResponse(
            status="SENT", 
            evotor_uuid=order.receipt.get("uuid"),
            error_text=""
        )

    # 2. Валидация реквизитов
    required_fields = [
        user.evotor_login, user.evotor_password, 
        user.kkt_id, user.inn, user.payment_address
    ]
    
    if not all(required_fields):
        return ReceiptResponse(status="ERROR", error_text="Не заполнены настройки Эвотор")

    try:
        # 3. Авторизация
        token = evotor_get_token(user.evotor_login, user.evotor_password)

        # 4. Операция
        operation_type = get_evotor_operation_type(order)

        # 5. Сборка JSON
        payload = build_receipt_payload_v5(order, user, receipt_data or {}, operation_type)

        # 6. Отправка
        response_data = evotor_register_receipt(
            token=token,
            group_code=user.kkt_id,
            operation=operation_type,
            payload=payload
        )
        
        evotor_uuid = response_data.get("uuid")

        # === ГЛАВНОЕ ИЗМЕНЕНИЕ: СОХРАНЯЕМ В БАЗУ ===
        # Сохраняем не только статус, но и данные, чтобы потом показать их в readonly полях
        saved_receipt_data = {
            "uuid": evotor_uuid,
            "status": "SENT",
            "timestamp": payload.get("timestamp"),
            # Сохраняем то, что ввел пользователь, чтобы потом отобразить в серых полях
            "contact": receipt_data.get("contact"),
            "price": receipt_data.get("price"),
            "amount": receipt_data.get("amount"),
            "sum": receipt_data.get("sum"),
        }
        
        order.receipt = saved_receipt_data
        order.save(update_fields=["receipt"])
        # ===========================================

        return ReceiptResponse(
            status="SENT", 
            evotor_uuid=evotor_uuid,
            error_text=""
        )

    except EvotorAtolError as e:
        return ReceiptResponse(status="ERROR", error_text=str(e))
        
    except Exception as e:
        return ReceiptResponse(status="ERROR", error_text=f"System Error: {str(e)}")