import logging
from datetime import datetime
from django.utils import timezone
from django.utils.timezone import make_aware
from bybit_p2p import P2P 
from .models import UnprocessedOrder, Order

# Настраиваем логгер, чтобы видеть ошибки в консоли/файле
logger = logging.getLogger(__name__)

def sync_bybit_orders(user):
    """
    Синхронизация ордеров Bybit.
    Возвращает количество добавленных ордеров.
    """
    # 1. Проверка ключей
    if not user.bybit_api_key or not user.bybit_api_secret:
        return 0

    try:
        # Инициализация библиотеки
        api = P2P(
            testnet=False,
            api_key=user.bybit_api_key,
            api_secret=user.bybit_api_secret,
            domain="bytick" # Если не работает, можно попробовать "main"
        )
    except Exception as e:
        logger.error(f"Bybit Init Error for {user.username}: {e}")
        return 0

    # 2. Сбор "Черных списков" (ID, которые уже есть в системе)
    
    # А) Уже обработанные (чистовые) ордера. В модели Order поле называется external_id
    processed_ids = set(
        Order.objects.filter(user=user)
        .exclude(external_id="")
        .values_list('external_id', flat=True)
    )
    
    # Б) Уже загруженные необработанные. В модели UnprocessedOrder поле называется order_id
    unprocessed_ids = set(
        UnprocessedOrder.objects.filter(user=user)
        .values_list('order_id', flat=True)
    )

    # Объединяем, чтобы проверять в одном месте
    ignore_ids = processed_ids.union(unprocessed_ids)

    # 3. Задачи для API (тянем и активные, и историю)
    tasks = [
        {"method": "get_pending_orders", "kwargs": {"page": 1, "size": 20}},
        {"method": "get_orders", "kwargs": {"page": 1, "size": 20}}
    ]

    new_orders_list = [] # Список объектов для массового сохранения

    for task in tasks:
        method_name = task["method"]
        try:
            if not hasattr(api, method_name):
                continue
            
            func = getattr(api, method_name)
            response = func(**task["kwargs"])
            
            # Проверяем успешность ответа Bybit
            if response.get("ret_code") == 0:
                items = response.get("result", {}).get("items", [])
                
                for item in items:
                    # Bybit может отдавать id или orderId в зависимости от эндпоинта
                    # Приводим к строке
                    bybit_id = str(item.get("id") or item.get("orderId"))
                    
                    # --- ГЛАВНЫЙ ФИЛЬТР ---
                    # 1. Если ID пустой - пропускаем
                    # 2. Если ID уже есть в БД (в Order или Unprocessed) - пропускаем
                    if not bybit_id or bybit_id in ignore_ids:
                        continue
                    
                    # 3. Если мы уже добавили этот ордер в текущем цикле (защита от дублей внутри пачки)
                    if any(o.order_id == bybit_id for o in new_orders_list):
                        continue

                    # --- ПАРСИНГ ДАННЫХ ---
                    
                    # Тип операции: Bybit отдает "1" для SELL (мы продаем крипту)
                    side_val = str(item.get("side"))
                    operation_type = "SELL" if side_val == "1" else "BUY"
                    
                    price = float(item.get("price") or 0)
                    
                    # notifyTokenQuantity - это количество криптовалюты (USDT)
                    crypto_amount = float(item.get("notifyTokenQuantity") or 0)
                    
                    # amount - это сумма в фиате (RUB)
                    fiat_amount = float(item.get("amount") or 0)

                    # Если крипта пришла 0 (бывает глюк), пробуем посчитать через цену
                    if crypto_amount == 0 and price > 0:
                        crypto_amount = fiat_amount / price

                    # Дата создания
                    try:
                        created_ms = int(item.get("createDate") or item.get("createTime") or 0)
                        if created_ms > 0:
                            dt = datetime.fromtimestamp(created_ms / 1000.0)
                            aware_dt = make_aware(dt)
                        else:
                            aware_dt = timezone.now()
                    except:
                        aware_dt = timezone.now()

                    # --- СОЗДАНИЕ ОБЪЕКТА В ПАМЯТИ ---
                    new_order_obj = UnprocessedOrder(
                        user=user,
                        order_id=bybit_id,          # Поле модели: order_id
                        operation_type=operation_type,
                        amount=crypto_amount,       # Поле модели: amount (крипта)
                        price=price,                # Поле модели: price
                        cost=fiat_amount,           # Поле модели: cost (рубли)
                        exchange_type="Bybit",      # Поле модели: exchange_type
                        created_at=aware_dt
                    )
                    
                    new_orders_list.append(new_order_obj)
                    
                    # Добавляем ID в игнор, чтобы не обработать его снова, если он встретится в другом методе
                    ignore_ids.add(bybit_id)

            else:
                logger.warning(f"Bybit API Error ({method_name}) user {user.username}: {response.get('ret_msg')}")

        except Exception as e:
            logger.error(f"Crash in {method_name} for {user.username}: {e}")

    # 4. МАССОВОЕ СОХРАНЕНИЕ В БД (1 запрос вместо N)
    if new_orders_list:
        UnprocessedOrder.objects.bulk_create(new_orders_list)
        logger.info(f"User {user.username}: Saved {len(new_orders_list)} new Bybit orders.")
        return len(new_orders_list)
    
    return 0