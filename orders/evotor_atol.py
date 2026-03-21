import requests
import uuid
import logging
import json
import re
from datetime import datetime, timedelta
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
    Сборка тела запроса v5. 
    Место расчетов берется по бирже ордера (Bybit, HTX, MEXC, Bitget, Telegram).
    Время корректируется на +3 часа (МСК).
    """
    
    # 1. Исправление времени (МСК +3)
    msk_time = datetime.now() + timedelta(hours=3)
    timestamp_str = msk_time.strftime("%d.%m.%Y %H:%M:%S")

    # 2. Уникальный ID
    external_id = f"ord_{order.id}_{uuid.uuid4().hex}"[:128]

    # 3. Данные клиента
    raw_contact = receipt_data.get("contact") or "client@example.com"
    client_obj = {}
    if "@" in raw_contact:
        client_obj["email"] = raw_contact
    else:
        clean_phone = re.sub(r"[^0-9]", "", raw_contact)
        if not clean_phone.startswith("+"):
            clean_phone = "+" + clean_phone
        client_obj["phone"] = clean_phone

    # 4. Данные компании и ЖЕСТКИЙ МАППИНГ МЕСТА РАСЧЕТОВ
    raw_tax_from_db = str(getattr(user, "tax_type", "")).strip().lower()
    tax_map = {"osn": "osn", "usn_income": "usn_income", "usn_income_outcome": "usn_income_outcome", "patent": "patent"}
    sno_value = tax_map.get(raw_tax_from_db, "osn")

    # === ЛОГИКА АДРЕСА БИРЖИ ===
    exchange_type = str(getattr(order, "exchange_type", "Bybit")).strip().lower()
    
    if "htx" in exchange_type or "huobi" in exchange_type:
        payment_address = "https://www.htx.com/"
    elif "mexc" in exchange_type:
        payment_address = "https://www.mexc.com/"
    elif "bitget" in exchange_type:       # <-- Добавлено
        payment_address = "https://www.bitget.com/"
    elif "telegram" in exchange_type:     # <-- Добавлено
        payment_address = "https://telegram.org/"
    elif "gate" in exchange_type:
        payment_address = "https://www.gate.com/"
    else:
        # По умолчанию Bybit
        payment_address = "https://www.bybit.com/"

    company_obj = {
        "email": user.email or "noreply@evotor.ru",
        "sno": sno_value,
        "inn": getattr(user, "inn", "") or "000000000000",
        "payment_address": payment_address # Уйдет в "Место расчетов"
    }

    # 5. Цифры
    def to_float(val):
        try: return float(str(val).replace(",", ".").strip())
        except: return 0.0

    quantity = to_float(receipt_data.get("amount") or getattr(order, "amount", 0))
    total_sum = to_float(receipt_data.get("sum") or getattr(order, "cost", 0))
    
    if total_sum <= 0: total_sum = 1.0
    if quantity <= 0: quantity = 1.0

    price = round(total_sum / quantity, 2)

    # 6. Позиции
    currency_name = getattr(order, "currency", "USDT")
    item_name = receipt_data.get("purpose") or f"Цифровая валюта {currency_name}"

    items_obj = [{
        "name": item_name[:128],
        "price": price,
        "quantity": quantity,
        "measure": 0,
        "sum": total_sum,
        "payment_method": "full_payment",
        "payment_object": 1, 
        "vat": {"type": "none"}
    }]

    payload = {
        "timestamp": timestamp_str,
        "external_id": external_id,
        "receipt": {
            "client": client_obj,
            "company": company_obj,
            "items": items_obj,
            "payments": [{"type": 1, "sum": total_sum}],
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

    # === ОТЛАДКА ===
    print("\n--- EVOTOR REQUEST DEBUG ---")
    print(f"URL: {url}")
    print(f"PAYLOAD: {json.dumps(payload, indent=2, ensure_ascii=False)}")
    print("----------------------------\n")

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
        try:
            data = response.json()
        except:
            data = {"text": response.text}

        if response.status_code >= 400:
            error_text = json.dumps(data, ensure_ascii=False)
            raise EvotorAtolError(f"HTTP {response.status_code}: {error_text}")

        if data.get("status") == "fail" or data.get("error"):
            error_info = data.get("error", {})
            raise EvotorAtolError(f"API Logic Error: {error_info}")

        return data

    except requests.RequestException as e:
        raise EvotorAtolError(f"Network Error: {str(e)}")