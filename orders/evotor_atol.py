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

    # 4. Данные компании (ИСПРАВЛЕННАЯ ЛОГИКА СНО)
    # Получаем значение из базы, превращаем в строку, убираем пробелы и делаем маленькими буквами
    raw_tax_from_db = str(getattr(user, "tax_type", "")).strip().lower()
    
    print(f"\n>>> DEBUG TAX: В базе лежит: '{raw_tax_from_db}' <<<\n")

    tax_map = {
        # === ОБЩАЯ СИСТЕМА (osn) ===
        "osn": "osn",
        "och": "osn",       # Для вашего старого значения 'OCH'
        "осн": "osn", 
        "osno": "osn",      # <--- ДЛЯ НОВОГО ЗНАЧЕНИЯ 'OSNO'
        "осно": "osn",      # На случай кириллицы
        "общая": "osn",

        # === УСН Доходы (usn_income) ===
        "usn_income": "usn_income",
        "usn доход": "usn_income",
        "усн доход": "usn_income",
        
        # === УСН Доходы-Расходы (usn_income_outcome) ===
        "usn_income_outcome": "usn_income_outcome",
        "usn доход-расход": "usn_income_outcome",
        "усн доход-расход": "usn_income_outcome",
        
        # === ПАТЕНТ (patent) ===
        "patent": "patent",
        "патент": "patent"
    }
    
    # Берем значение из карты, если нет — ставим 'osn' (раз у вас ОСНО)
    sno_value = tax_map.get(raw_tax_from_db, "osn")

    company_obj = {
        "email": user.email or "noreply@evotor.ru",
        "sno": sno_value,
        "inn": getattr(user, "inn", "") or "000000000000",
        "payment_address": getattr(user, "payment_address", "") or "https://mysite.com"
    }

    # 5. Суммы
    def to_float(val):
        try: return float(val)
        except: return 1.0

    raw_sum = receipt_data.get("sum") or order.cost
    total_sum = to_float(raw_sum)
    if total_sum <= 0: total_sum = 1.0 

    # 6. Позиции
    item_name = (receipt_data.get("purpose") or f"Order {order.external_id}")[:128]
    
    items_obj = [
        {
            "name": item_name,
            "price": total_sum,
            "quantity": 1.0,
            "measure": 0,          
            "sum": total_sum,      
            "payment_method": "full_payment",
            "payment_object": 4,   
            "vat": {
                "type": "none"     
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