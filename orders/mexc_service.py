import hmac
import hashlib
import time
import urllib.parse
import requests
import concurrent.futures
from datetime import datetime, timedelta
from django.utils.timezone import make_aware

class DisplayOrder:
    """
    Класс-заглушка для отображения данных в шаблоне.
    """
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

def _fetch_single_user_mexc(user, time_threshold_ms):
    """
    Логика получения ордеров MEXC для одного пользователя.
    """
    # 1. Проверка ключей
    if not user.mexc_api_key or len(str(user.mexc_api_key)) < 5:
        return []
    if not user.mexc_api_secret or len(str(user.mexc_api_secret)) < 5:
        return []

    orders_buffer = []
    base_url = "https://api.mexc.com"
    endpoint = "/api/v3/fiat/orders"

    try:
        # Параметры запроса (по документации V3)
        params = {
            'limit': 100, # Максимум 100
            'startTime': time_threshold_ms, # Ордера новее чем 24 часа
            'timestamp': int(time.time() * 1000)
        }

        # Генерация подписи
        # 1. Сортировка не обязательна по стандарту V3, но query_string нужна
        query_string = urllib.parse.urlencode(params)
        
        # 2. HMAC SHA256
        signature = hmac.new(
            user.mexc_api_secret.encode('utf-8'),
            query_string.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        params['signature'] = signature

        headers = {
            "X-MEXC-APIKEY": user.mexc_api_key,
            "Content-Type": "application/json"
        }

        # Запрос (таймаут 5 сек, чтобы не вешать страницу)
        response = requests.get(base_url + endpoint, params=params, headers=headers, timeout=5)
        
        try:
            data = response.json()
        except:
            return []

        # MEXC может вернуть список сразу или словарь с ключом 'data'
        items = data if isinstance(data, list) else data.get('data', [])

        for item in items:
            # Парсинг данных
            # tradeType: 0 = BUY, 1 = SELL (согласно докам)
            trade_type_raw = str(item.get('tradeType'))
            operation_type = 'SELL' if trade_type_raw == '1' else 'BUY'

            # Время (у MEXC createTime в мс)
            create_ts = int(item.get('createTime', 0))
            
            # Дата
            try:
                dt = datetime.fromtimestamp(create_ts / 1000.0)
                aware_dt = make_aware(dt)
            except:
                aware_dt = datetime.now()

            # ID
            order_id = str(item.get('orderNo'))

            # Суммы
            # В MEXC P2P API обычно: amount = Fiat cost, quantity = Crypto amount
            cost_fiat = float(item.get('amount', 0))
            amount_crypto = float(item.get('quantity', 0))
            price = float(item.get('price', 0))

            status_raw = str(item.get('status'))

            # Добавляем в буфер
            orders_buffer.append(DisplayOrder(
                external_id=order_id,
                user=user,
                user_username=user.username,
                exchange="MEXC",
                operation_type=operation_type,
                amount=amount_crypto,
                price=price,
                cost=cost_fiat,
                created_at=aware_dt,
                status=status_raw
            ))

    except Exception as e:
        # print(f"MEXC Logic Error for {user.username}: {e}")
        pass

    return orders_buffer

def get_mexc_orders_parallel(users_queryset, filters=None):
    """
    Запускает параллельный опрос пользователей для MEXC.
    """
    all_orders = []
    
    # Порог времени: 24 часа назад в мс
    time_threshold = datetime.now() - timedelta(hours=24)
    time_threshold_ms = int(time_threshold.timestamp() * 1000)

    # 10 потоков
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_user = {
            executor.submit(_fetch_single_user_mexc, user, time_threshold_ms): user 
            for user in users_queryset
        }
        
        for future in concurrent.futures.as_completed(future_to_user):
            try:
                data = future.result()
                all_orders.extend(data)
            except Exception:
                continue

    # Фильтрация
    if filters:
        if filters.get('type'):
            all_orders = [x for x in all_orders if x.operation_type == filters['type']]
        
        # Если запросили НЕ MEXC, очищаем список
        if filters.get('exchange'):
            req_exch = filters['exchange']
            if req_exch != 'MEXC' and req_exch != '': 
                all_orders = []

    # Сортировка будет сделана в общем списке во view, но можно и тут
    all_orders.sort(key=lambda x: x.created_at, reverse=True)
    return all_orders