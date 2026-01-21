import concurrent.futures
from datetime import datetime, timedelta
from django.utils.timezone import make_aware
# Используем твою библиотеку
from bybit_p2p import P2P 

class DisplayOrder:
    """
    Класс-заглушка, чтобы данные в шаблоне выглядели как объект Django-модели.
    """
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

def _fetch_single_user_logic(user, time_threshold_ms):
    """
    Функция опроса одного пользователя.
    Основана на твоем коде sync_bybit_orders, но возвращает список, а не сохраняет в БД.
    """
    # 1. Жесткая проверка ключей перед запуском, чтобы не спамить лог ошибками 10003
    if not user.bybit_api_key or len(str(user.bybit_api_key)) < 5:
        return []
    if not user.bybit_api_secret or len(str(user.bybit_api_secret)) < 5:
        return []

    orders_buffer = []

    try:
        # Инициализация (Твой код)
        api = P2P(
            testnet=False,
            api_key=user.bybit_api_key,
            api_secret=user.bybit_api_secret,
            domain="bytick"
        )
        
        # Задачи (Твой код)
        tasks = [
            {"method": "get_pending_orders", "kwargs": {"page": 1, "size": 20}},
            {"method": "get_orders", "kwargs": {"page": 1, "size": 20}}
        ]

        processed_ids = set()

        for task in tasks:
            if not hasattr(api, task["method"]):
                continue
            
            func = getattr(api, task["method"])
            # Вызов API
            response = func(**task["kwargs"])
            
            if response.get("ret_code") == 0:
                items = response.get("result", {}).get("items", [])
                
                for item in items:
                    # Проверка времени (Оставляем только за 24 часа)
                    created_ms = int(item.get("createDate") or item.get("createTime") or 0)
                    if created_ms < time_threshold_ms:
                        continue 

                    order_id = str(item.get("id") or item.get("orderId"))
                    
                    # Избегаем дублей внутри одного прохода
                    if order_id in processed_ids:
                        continue
                    processed_ids.add(order_id)

                    # --- ТВОЯ ЛОГИКА ПАРСИНГА ---
                    side_val = str(item.get("side"))
                    operation_type = "SELL" if side_val == "1" else "BUY"
                    
                    price = float(item.get("price") or 0)
                    crypto_amount = float(item.get("notifyTokenQuantity") or 0)
                    fiat_amount = float(item.get("amount") or 0)

                    # Твой фикс: если крипты 0, считаем через цену
                    if crypto_amount == 0 and price > 0:
                        crypto_amount = fiat_amount / price

                    # Дата
                    try:
                        dt = datetime.fromtimestamp(created_ms / 1000.0)
                        aware_dt = make_aware(dt)
                    except:
                        aware_dt = datetime.now()

                    status_code = str(item.get("orderStatus"))

                    # Создаем объект в памяти
                    orders_buffer.append(DisplayOrder(
                        external_id=order_id,
                        user=user,              # Ссылка на объект User
                        exchange_type="Bybit",
                        operation_type=operation_type,
                        amount=crypto_amount,
                        price=price,
                        cost=fiat_amount,
                        created_at=aware_dt,
                        status_raw=status_code,
                        bank_detail={'name': 'P2P API'} # Заглушка
                    ))
            else:
                # Тихий пропуск ошибок, чтобы не ломать поток
                pass

    except Exception as e:
        # Можно включить print для отладки, но лучше оставить чистым
        pass

    return orders_buffer

def get_orders_parallel(users_queryset, filters=None):
    """
    Запускает параллельный опрос переданных пользователей.
    """
    all_orders = []
    
    # Порог времени: 24 часа назад в миллисекундах
    time_threshold = datetime.now() - timedelta(hours=24)
    time_threshold_ms = int(time_threshold.timestamp() * 1000)

    # Запускаем в 10 потоков
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_user = {
            executor.submit(_fetch_single_user_logic, user, time_threshold_ms): user 
            for user in users_queryset
        }
        
        for future in concurrent.futures.as_completed(future_to_user):
            try:
                data = future.result()
                all_orders.extend(data)
            except Exception:
                continue

    # --- Применяем фильтры (Python list filtering) ---
    if filters:
        # Фильтр Тип (BUY/SELL)
        if filters.get('type'):
            all_orders = [x for x in all_orders if x.operation_type == filters['type']]
        
        # Фильтр Источник (Пока только Bybit, но логика на будущее)
        if filters.get('exchange'):
            req_exch = filters['exchange']
            # Если запросили НЕ Bybit и НЕ "Все", очищаем список (т.к. у нас пока только Bybit)
            if req_exch != '1' and req_exch != '': 
                all_orders = []

    # Сортировка: новые сверху
    all_orders.sort(key=lambda x: x.created_at, reverse=True)
    return all_orders