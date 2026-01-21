from datetime import datetime
from django.utils.timezone import make_aware
from bybit_p2p import P2P 
from .models import UnprocessedOrder, Order

def sync_bybit_orders(user):
    # 1. Проверка ключей
    if not user.bybit_api_key or not user.bybit_api_secret:
        return False

    print(f"--- [MINIMAL] ЗАПУСК BYBIT P2P (TEST 1 CONFIG) ---")

    try:
        # Инициализация
        api = P2P(
            testnet=False,
            api_key=user.bybit_api_key,
            api_secret=user.bybit_api_secret,
            domain="bytick"
        )
    except Exception as e:
        print(f"Ошибка библиотеки: {e}")
        return False

    # Кэш
    try:
        existing_ids = set(Order.objects.filter(user=user).values_list('external_id', flat=True))
    except:
        existing_ids = set(Order.objects.filter(user=user).values_list('order_id', flat=True))
    existing_unprocessed = set(UnprocessedOrder.objects.filter(user=user).values_list('order_id', flat=True))

    # === ИЗМЕНЕНИЕ ===
    # Убрали tokenId="USDT". Оставили только page и size.
    # Это точная копия "TEST 1", который сработал в консоли.
    tasks = [
        {"method": "get_pending_orders", "kwargs": {"page": 1, "size": 20}},
        {"method": "get_orders", "kwargs": {"page": 1, "size": 20}}
    ]

    count_new = 0

    for task in tasks:
        method_name = task["method"]
        try:
            if not hasattr(api, method_name):
                continue
            
            func = getattr(api, method_name)
            response = func(**task["kwargs"])
            
            if response.get("ret_code") == 0:
                items = response.get("result", {}).get("items", [])
                
                for item in items:
                    order_id = str(item.get("id") or item.get("orderId"))
                    
                    if order_id and order_id not in existing_ids and order_id not in existing_unprocessed:
                        # Парсинг
                        side_val = str(item.get("side"))
                        operation_type = "SELL" if side_val == "1" else "BUY"
                        
                        # Определяем валюту и токен из ответа
                        # Обычно tokenId="USDT" приходит в ответе
                        token_id = item.get("tokenId") or "USDT"
                        
                        price = float(item.get("price") or 0)
                        crypto_amount = float(item.get("notifyTokenQuantity") or 0)
                        fiat_amount = float(item.get("amount") or 0)

                        if crypto_amount == 0 and price > 0:
                            crypto_amount = fiat_amount / price

                        try:
                            created_ms = int(item.get("createDate") or item.get("createTime") or 0)
                            dt = datetime.fromtimestamp(created_ms / 1000.0)
                            aware_dt = make_aware(dt)
                        except:
                            aware_dt = datetime.now()

                        UnprocessedOrder.objects.create(
                            user=user,
                            order_id=order_id,
                            operation_type=operation_type,
                            amount=crypto_amount,
                            price=price,
                            exchange_type="Bybit", # Или можно использовать token_id
                            created_at=aware_dt
                        )
                        count_new += 1
                        print(f"   >>> OK: {order_id}")
            else:
                print(f"Bybit Error ({method_name}): {response.get('ret_msg')}")

        except Exception as e:
            print(f"Crash in {method_name}: {e}")

    print(f"--- ЗАВЕРШЕНО. НОВЫХ: {count_new} ---")
    return True