import time
import hmac
import hashlib
import requests
from datetime import datetime, timezone as dt_timezone
from .models import Order, UnprocessedOrder

def generate_signature(api_secret, payload):
    return hmac.new(
        api_secret.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

def sync_bybit_orders(user):
    if not user.bybit_api_key or not user.bybit_api_secret:
        return {"status": "warning", "message": "Ключи не настроены"}

    api_key = user.bybit_api_key
    api_secret = user.bybit_api_secret
    
    # Используем основной домен
    base_url = "https://api.bybit.com"
    endpoint = "/v5/fiat/order-record"
    
    timestamp = str(int(time.time() * 1000))
    recv_window = "10000"
    params = "limit=50"

    # Подпись для GET: timestamp + api_key + recv_window + queryString
    signature_payload = timestamp + api_key + recv_window + params
    signature = generate_signature(api_secret, signature_payload)

    headers = {
        'X-BAPI-API-KEY': api_key,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recv_window,
        # Добавляем User-Agent, чтобы Bybit не блокировал запрос как бота
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }

    try:
        url = f"{base_url}{endpoint}?{params}"
        print(f"\n🚀 Запрос к: {url}")
        
        response = requests.get(url, headers=headers, timeout=15)
        
        # Если статус не 200, выводим причину
        if response.status_code != 200:
            print(f"❌ Ошибка сервера: Код {response.status_code}")
            print(f"📝 Текст ошибки: {response.text[:500]}")
            return {"status": "error", "message": f"Bybit вернул код {response.status_code}"}

        # Проверка на пустой ответ
        if not response.text:
            print("❌ Ошибка: Сервер вернул пустой ответ (Empty body)")
            return {"status": "error", "message": "Пустой ответ от сервера"}

        try:
            res = response.json()
        except Exception as e:
            print(f"❌ Ошибка декодирования JSON: {e}")
            print(f"📝 Текст ответа (первые 300 симв): {response.text[:300]}")
            return {"status": "error", "message": "Ошибка формата данных"}

        if res.get('retCode') == 0:
            order_list = res.get('result', {}).get('list', [])
            print(f"✅ Успешно! Найдено записей: {len(order_list)}")
            
            count_new = 0
            for item in order_list:
                order_id = str(item.get('orderId'))
                
                # Фильтруем только P2P (длинные числовые ID)
                if not order_id.isdigit() or len(order_id) < 10:
                    continue

                if Order.objects.filter(external_id=order_id).exists(): continue
                if UnprocessedOrder.objects.filter(order_id=order_id).exists(): continue

                # Маппинг данных
                side = item.get('side', 'BUY').upper()
                amount = float(item.get('amount', 0))
                price = float(item.get('price', 0))
                ts = int(item.get('createTime', time.time()*1000)) / 1000
                
                UnprocessedOrder.objects.create(
                    user=user,
                    order_id=order_id,
                    operation_type=side,
                    amount=amount,
                    price=price,
                    created_at=datetime.fromtimestamp(ts, tz=dt_timezone.utc),
                    exchange_type='BYBIT'
                )
                count_new += 1
            
            return {"status": "success", "message": f"Обновлено. Добавлено: {count_new}"}
        else:
            print(f"⚠️ Bybit Error: {res.get('retMsg')} ({res.get('retCode')})")
            return {"status": "error", "message": res.get('retMsg')}

    except Exception as e:
        print(f"❌ Ошибка соединения: {str(e)}")
        return {"status": "error", "message": "Не удалось связаться с Bybit"}