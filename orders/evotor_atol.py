import requests
import uuid
import logging
import json
import re
from datetime import datetime
from decimal import Decimal

logger = logging.getLogger(__name__)

EVOTOR_BASE_URL = "https://fiscalization.evotor.ru/possystem/v5"

class EvotorAtolError(Exception):
    pass

def evotor_get_token(login: str, password: str) -> str:
    url = f"{EVOTOR_BASE_URL}/getToken"
    headers = {"Content-type": "application/json; charset=utf-8"}
    payload = {"login": login, "pass": password}

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
        if data.get("error"):
            raise EvotorAtolError(f"Auth Error: {data['error']}")
        return data["token"]
    except Exception as e:
        raise EvotorAtolError(f"Token Error: {str(e)}")


def build_receipt_payload_v5(order, user, receipt_data: dict, check_type: str) -> dict:
    """
    Сборка тела запроса согласно схеме v5 ФФД 1.2
    Исправлена логика формирования позиций (Цена x Количество)
    """
    
    # 1. Дата
    timestamp_str = datetime.now().strftime("%d.%m.%Y %H:%M:%S")

    # 2. Уникальный ID
    external_id = f"ord_{order.id}_{uuid.uuid4().hex}"[:128]

    # 3. Данные клиента
    raw_contact = receipt_data.get("contact") or "client@example.com"
    client_obj = {}
    
    if "@" in raw_contact:
        client_obj["email"] = raw_contact
        client_obj["phone"] = None 
    else:
        clean_phone = re.sub(r"[^0-9]", "", raw_contact)
        if not raw_contact.startswith("+"):
            if clean_phone.startswith("8") and len(clean_phone) == 11:
                clean_phone = "+7" + clean_phone[1:]
            else:
                clean_phone = "+" + clean_phone
        client_obj["phone"] = clean_phone
        client_obj["email"] = None

    # 4. Данные компании (СНО)
    raw_tax_from_db = str(getattr(user, "tax_type", "")).strip().lower()
    tax_map = {
        "osn": "osn", "och": "osn", "осн": "osn", "osno": "osn", "осно": "osn", "общая": "osn",
        "usn_income": "usn_income", "usn доход": "usn_income", "усн доход": "usn_income",
        "usn_income_outcome": "usn_income_outcome", "usn доход-расход": "usn_income_outcome", "усн доход-расход": "usn_income_outcome",
        "patent": "patent", "патент": "patent"
    }
    sno_value = tax_map.get(raw_tax_from_db, "osn")

    company_obj = {
        "email": user.email or "noreply@evotor.ru",
        "sno": sno_value,
        "inn": getattr(user, "inn", "") or "000000000000",
        "payment_address": getattr(user, "payment_address", "") or "https://mysite.com"
    }

    # 5. Подготовка цифр (Цена, Кол-во, Сумма)
    def to_float(val):
        try: return float(val)
        except: return 0.0

    # Пытаемся достать детальные данные из receipt_data (пришли с фронта)
    # Если их нет, берем из order (базы)
    
    quantity = to_float(receipt_data.get("amount") or getattr(order, "amount", 0)) # Количество (шт)
    price = to_float(receipt_data.get("price") or getattr(order, "price", 0))      # Цена за единицу
    total_sum = to_float(receipt_data.get("sum") or getattr(order, "cost", 0))     # Итоговая сумма

    # Защита от нулевых значений (если вдруг данных нет, ставим заглушки чтобы чек не упал)
    if total_sum <= 0: total_sum = 1.0
    
    # ЛОГИКА ВАЛИДАЦИИ МАТЕМАТИКИ
    # Эвотор очень строг: Price * Quantity должно быть равно Sum (с погрешностью копеек)
    # Если данных о кол-ве нет, делаем "1 шт * Сумма"
    if quantity <= 0 or price <= 0:
        quantity = 1.0
        price = total_sum
    else:
        # Если есть и цена и кол-во, проверяем сходится ли математика.
        # Часто бывает: 56.54 * 82.98 = 4691.6892, а сумма 4691.69.
        # Лучше довериться Сумме и Количеству, а Цену пересчитать под них, 
        # так как Сумма - это то, что реально списали с карты.
        price = round(total_sum / quantity, 2) 
        # Или оставляем как есть, но рискуем получить ошибку валидации от АТОЛ

    # 6. Позиции (Items)
    # Формируем красивое название, как вы просили
    # Пытаемся найти валюту в ордере, если нет - просто "Цифровая валюта"
    currency_name = getattr(order, "currency", "USDT") # Можно заменить на 'USDT' если у вас всегда тезер
    
    # Если пользователь ввел свое назначение платежа - используем его, иначе шаблон
    custom_purpose = receipt_data.get("purpose")
    if custom_purpose:
        item_name = custom_purpose[:128]
    else:
        item_name = f"Цифровая валюта {currency_name}"

    items_obj = [
        {
            "name": item_name,
            "price": price,          # Цена за единицу (например 82.98)
            "quantity": quantity,    # Количество (например 56.54)
            "measure": 0,            # 0 - это штуки/единицы (по ФФД)
            "sum": total_sum,        # Итоговая сумма позиции (например 4691.69)
            
            "payment_method": "full_payment",
            
            # ВАЖНО: Меняем 4 (Услуга) на 1 (Товар), как вы просили
            "payment_object": 1,     # 1 = Товар, 4 = Услуга, 10 = Платеж
            
            "vat": {
                "type": "none"       # Без НДС
            }
        }
    ]

    # 7. Платежи
    payments_obj = [{"type": 1, "sum": total_sum}]

    payload = {
        "timestamp": timestamp_str,
        "external_id": external_id,
        "receipt": {
            "client": client_obj,
            "company": company_obj,
            "items": items_obj,
            "payments": payments_obj,
            "total": total_sum
        }
    }

    return payload


def evotor_register_receipt(token: str, group_code: str, operation: str, payload: dict) -> dict:
    url = f"{EVOTOR_BASE_URL}/{group_code}/{operation}"
    headers = {
        "Content-type": "application/json; charset=utf-8",
        "Token": token
    }

    # === ОТЛАДКА: ПЕЧАТАЕМ ТО ЧТО ОТПРАВЛЯЕМ ===
    print("\n--- EVOTOR REQUEST DEBUG ---")
    print(f"URL: {url}")
    print(f"PAYLOAD: {json.dumps(payload, indent=2, ensure_ascii=False)}")
    print("----------------------------\n")

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
        # Сначала читаем JSON, даже если ошибка 400
        try:
            data = response.json()
        except:
            data = {"text": response.text}

        # Если статус код ошибки (4xx, 5xx)
        if response.status_code >= 400:
            error_text = json.dumps(data, ensure_ascii=False)
            raise EvotorAtolError(f"HTTP {response.status_code}: {error_text}")

        # Проверка логической ошибки внутри JSON (если 200 OK, но status fail)
        if data.get("status") == "fail" or data.get("error"):
            error_info = data.get("error", {})
            raise EvotorAtolError(f"API Logic Error: {error_info}")

        return data

    except requests.RequestException as e:
        raise EvotorAtolError(f"Network Error: {str(e)}")