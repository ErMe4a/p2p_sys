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
    Реализует подпись HMAC SHA256 согласно документации v1.2.
    """
    endpoint = "/api/v3/fiat/retrieveOrderList"
    
    # 1. Формируем параметры
    params = {
        "page": 1,
        "limit": 50,  # Забираем последние 50 сделок
        "timestamp": int(time.time() * 1000), # Unix time в мс
        "recvWindow": 10000 # Окно валидности (защита от задержек сети)
    }

    # 2. Генерация подписи (Самая важная часть)
    # Параметры должны быть отсортированы по алфавиту для хеша
    query_string = urllib.parse.urlencode(sorted(params.items()))
    
    # Создаем HMAC SHA256 подпись
    signature = hmac.new(
        api_secret.encode('utf-8'),
        query_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    # 3. Итоговый URL с параметрами и подписью
    full_query = f"{query_string}&signature={signature}"
    url = f"{MEXC_BASE_URL}{endpoint}?{full_query}"
    
    headers = {
        "X-MEXC-APIKEY": api_key,
        "Content-Type": "application/json"
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)
        data = response.json()
        
        # Проверяем код успеха (в доке: code 0 = success)
        if str(data.get("code")) == "0":
            # Возвращаем список ордеров. В MEXC он лежит в data -> result
            return data.get("data", {}).get("result", [])
        else:
            print(f"MEXC API Error: {data.get('msg', 'Unknown error')}")
            return []
            
    except Exception as e:
        print(f"MEXC Request Failed: {e}")
        return []

def sync_mexc_orders(user):
    """
    Синхронизация ордеров MEXC и сохранение в БД (как в Bybit).
    """
    # 1. Проверка ключей
    if not user.mexc_api_key or not user.mexc_api_secret:
        return False

    print(f"--- [SYNC] ЗАПУСК MEXC P2P ---")

    # 2. Получаем ордера с биржи
    mexc_items = get_mexc_p2p_orders(user.mexc_api_key, user.mexc_api_secret)
    
    if not mexc_items:
        print("Нет данных от MEXC или ошибка подключения.")
        return False

    # 3. Кэш существующих ID (чтобы не дублировать)
    # Проверяем и в обработанных (Order), и в необработанных (UnprocessedOrder)
    try:
        # Пробуем external_id, если такой есть в модели Order
        existing_ids = set(Order.objects.filter(user=user).values_list('external_id', flat=True))
    except:
        existing_ids = set(Order.objects.filter(user=user).values_list('order_id', flat=True))
        
    existing_unprocessed = set(UnprocessedOrder.objects.filter(user=user).values_list('order_id', flat=True))

    count_new = 0

    # 4. Обработка списка
    for item in mexc_items:
        try:
            # ID ордера (в MEXC это поле orderId)
            order_id = str(item.get("orderId"))

            # Проверка на дубликаты
            if order_id in existing_ids or order_id in existing_unprocessed:
                continue

            # --- Маппинг данных (Согласно PDF MEXC v1.2) ---
            
            # Тип операции: В доке сказано Side: BUY(0), SELL(1)
            # Нам нужно превратить это в твои "BUY"/"SELL"
            trade_type_raw = item.get("tradeType") # Может быть 0 или 1
            if str(trade_type_raw) == "1":
                operation_type = "SELL"
            else:
                operation_type = "BUY"

            # Суммы и цены
            # amount - это количество крипты (например, 100 USDT)
            # money - это сумма в фиате (например, 9000 RUB)
            crypto_amount = float(item.get("amount") or 0)
            price = float(item.get("price") or 0)
            
            # Если цена 0 (бывает при глюках), пытаемся вычислить
            fiat_amount = float(item.get("money") or 0)
            if price == 0 and crypto_amount > 0:
                price = fiat_amount / crypto_amount

            # Дата создания
            try:
                # MEXC отдает createTime в миллисекундах (строкой)
                create_time_ms = int(item.get("createTime") or 0)
                dt = datetime.fromtimestamp(create_time_ms / 1000.0)
                aware_dt = make_aware(dt)
            except:
                aware_dt = datetime.now()

            # 5. Сохранение в БД
            UnprocessedOrder.objects.create(
                user=user,
                order_id=order_id,
                operation_type=operation_type,
                amount=crypto_amount, # Количество крипты
                price=price,          # Курс
                exchange_type="MEXC", # Явно указываем биржу
                created_at=aware_dt
            )
            
            count_new += 1
            print(f"   >>> MEXC OK: {order_id}")

        except Exception as e:
            print(f"Ошибка при обработке ордера MEXC {item.get('orderId')}: {e}")

    print(f"--- MEXC ЗАВЕРШЕНО. НОВЫХ: {count_new} ---")
    return True