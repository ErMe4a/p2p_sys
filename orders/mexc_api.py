import hmac
import hashlib
import urllib.parse
import time
import requests
import json
from datetime import datetime
from django.utils.timezone import make_aware
from .models import UnprocessedOrder, Order

# Константы для MEXC
MEXC_BASE_URL = "https://api.mexc.com"

def get_mexc_p2p_orders(api_key, api_secret):
    """
    Получение списка P2P ордеров с MEXC.
    """
    endpoint = "/api/v3/fiat/retrieveOrderList"
    
    # 1. Формируем параметры
    params = {
        "page": 1,
        "limit": 50,
        "timestamp": int(time.time() * 1000), 
        "recvWindow": 10000 
    }

    # 2. Генерация подписи
    query_string = urllib.parse.urlencode(sorted(params.items()))
    
    signature = hmac.new(
        api_secret.encode('utf-8'),
        query_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    full_query = f"{query_string}&signature={signature}"
    url = f"{MEXC_BASE_URL}{endpoint}?{full_query}"
    
    headers = {
        "X-MEXC-APIKEY": api_key,
        "Content-Type": "application/json"
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)
        data = response.json()
        
        if str(data.get("code")) == "0":
            return data.get("data", {}).get("result", [])
        else:
            # Ошибки API логируем, это полезно
            print(f"MEXC API Error: {data.get('msg', 'Unknown error')}")
            return []
            
    except Exception as e:
        print(f"MEXC Request Failed: {e}")
        return []

def sync_mexc_orders(user):
    """
    Синхронизация ордеров MEXC.
    """
    if not user.mexc_api_key or not user.mexc_api_secret:
        return False

    mexc_items = get_mexc_p2p_orders(user.mexc_api_key, user.mexc_api_secret)
    
    if not mexc_items:
        return False

    try:
        existing_ids = set(Order.objects.filter(user=user).values_list('external_id', flat=True))
    except:
        existing_ids = set(Order.objects.filter(user=user).values_list('order_id', flat=True))
        
    existing_unprocessed = set(UnprocessedOrder.objects.filter(user=user).values_list('order_id', flat=True))

    count_new = 0

    for item in mexc_items:
        try:
            order_id = str(item.get("orderId"))

            if order_id in existing_ids or order_id in existing_unprocessed:
                continue

            # Маппинг данных
            trade_type_raw = item.get("tradeType")
            if str(trade_type_raw) == "1":
                operation_type = "SELL"
            else:
                operation_type = "BUY"

            crypto_amount = float(item.get("amount") or 0)
            price = float(item.get("price") or 0)
            fiat_amount = float(item.get("money") or 0)
            
            if price == 0 and crypto_amount > 0:
                price = fiat_amount / crypto_amount

            try:
                create_time_ms = int(item.get("createTime") or 0)
                dt = datetime.fromtimestamp(create_time_ms / 1000.0)
                aware_dt = make_aware(dt)
            except:
                aware_dt = datetime.now()

            UnprocessedOrder.objects.create(
                user=user,
                order_id=order_id,
                operation_type=operation_type,
                amount=crypto_amount, # Количество крипты
                price=price,          # Курс
                total_amount=fiat_amount, # Сумма в рублях (ВАЖНО для таблицы)
                exchange_type="MEXC",
                created_at=aware_dt
            )
            count_new += 1

        except Exception as e:
            print(f"Error parsing MEXC item: {e}")

    return True