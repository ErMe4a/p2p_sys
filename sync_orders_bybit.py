"""
Запуск рядом с manage.py:

    # Диагностика — показывает расхождения без изменений:
    python sync_orders_bybit.py

    # Применить изменения:
    python sync_orders_bybit.py --update

Работает только для пользователя: abisalov

Точность сравнения:
    price, cost  — до 2 знаков (11.56 == 11.5606  -> OK)
    amount       — до 3 знаков  (5.780 == 5.78030  -> OK)

Что НЕ трогает: комиссию, банк, скриншот, чек, дату.
"""

import os
import sys
import django
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")  # <-- поменяй если надо

try:
    django.setup()
except Exception as e:
    print(f"Ошибка инициализации Django: {e}")
    print("Проверь DJANGO_SETTINGS_MODULE (смотри в manage.py)")
    sys.exit(1)

import time
from bybit_p2p import P2P
from orders.models import Order
from django.contrib.auth import get_user_model

User = get_user_model()
DO_UPDATE = "--update" in sys.argv

TARGET_USERNAME = "abisalov"

# Тянем ордера только начиная с этой даты
DATE_FROM_MS = int(datetime(2026, 2, 1).timestamp() * 1000)

PRECISION = {
    "price":  Decimal("0.01"),
    "cost":   Decimal("0.01"),
    "amount": Decimal("0.001"),
}


def fetch_all_bybit_orders(api, username: str) -> dict:
    result = {}
    page = 1

    while True:
        try:
            response = api.get_orders(page=page, size=30, status=50)
        except Exception as e:
            print(f"  [!] Ошибка запроса страницы {page}: {e}")
            break

        ret_code = response.get("ret_code")
        if ret_code is None:
            ret_code = response.get("retCode")

        if ret_code != 0:
            msg = response.get("ret_msg") or response.get("retMsg") or "unknown"
            print(f"  [!] Bybit API ошибка (страница {page}): code={ret_code} msg={msg}")
            if page == 1:
                return None
            break

        items = (
            response.get("result", {}).get("items")
            or response.get("result", {}).get("list")
            or []
        )

        if not items:
            break

        for item in items:
            order_id = str(item.get("id") or item.get("orderId") or "").strip()
            if order_id:
                result[order_id] = _parse_item(item)

        print(f"  Страница {page}: получено {len(items)} ордеров  (всего: {len(result)})")

        # Останавливаемся если последний ордер страницы старше DATE_FROM_MS
        last_item_ms = int(
            items[-1].get("createDate") or items[-1].get("createTime") or 0
        )
        if len(items) < 30 or last_item_ms < DATE_FROM_MS:
            break

        page += 1
        time.sleep(0.3)

    return result


def _parse_item(item: dict) -> dict:
    side_val = str(item.get("side") or "")
    operation_type = "SELL" if side_val == "1" else "BUY"

    price = _to_decimal(item.get("price"))
    crypto_amount = _to_decimal(
        item.get("notifyTokenQuantity") or item.get("quantity")
    )
    fiat_amount = _to_decimal(item.get("amount"))

    if crypto_amount == Decimal("0") and price > 0 and fiat_amount > 0:
        crypto_amount = (fiat_amount / price).quantize(
            Decimal("0.00000001"), rounding=ROUND_DOWN
        )

    return {
        "price":          price,
        "amount":         crypto_amount,
        "cost":           fiat_amount,
        "operation_type": operation_type,
    }


def _to_decimal(value) -> Decimal:
    try:
        return Decimal(str(float(value or 0)))
    except Exception:
        return Decimal("0")


def _round(value, precision: Decimal) -> Decimal:
    try:
        return Decimal(str(value or 0)).quantize(precision, rounding=ROUND_HALF_UP)
    except Exception:
        return Decimal("0")


def fields_differ(order: Order, api_data: dict) -> list:
    diffs = []
    for field in ("price", "cost", "amount"):
        precision = PRECISION[field]
        db_val  = _round(getattr(order, field), precision)
        api_val = _round(api_data[field], precision)
        if db_val != api_val:
            # Показываем только если разница больше 5
            if abs(db_val - api_val) > Decimal("5"):
                diffs.append((field, getattr(order, field), api_data[field]))
    if order.operation_type != api_data["operation_type"]:
        diffs.append(("operation_type", order.operation_type, api_data["operation_type"]))
    return diffs


def main():
    print("=" * 80)
    if DO_UPDATE:
        print(f"  РЕЖИМ: ОБНОВЛЕНИЕ (--update)  |  пользователь: {TARGET_USERNAME}")
    else:
        print(f"  РЕЖИМ: ДИАГНОСТИКА (без изменений)  |  пользователь: {TARGET_USERNAME}")
        print(f"  Чтобы применить: python sync_orders_bybit.py --update")
    print("=" * 80)

    try:
        user = User.objects.get(username=TARGET_USERNAME)
    except User.DoesNotExist:
        print(f"\n[!] Пользователь '{TARGET_USERNAME}' не найден в БД.")
        sys.exit(1)

    has_keys = bool(
        getattr(user, "bybit_api_key", None)
        and getattr(user, "bybit_api_secret", None)
    )

    if not has_keys:
        print(f"\n[!] У пользователя '{TARGET_USERNAME}' нет API ключей Bybit.")
        sys.exit(1)

    orders = (
        Order.objects
        .filter(user=user, exchange_type__in=["Bybit", "BYBIT"])
        .exclude(external_id="")
        .exclude(external_id__isnull=True)
        .order_by("-created_at")
    )

    print(f"\nПользователь: {user.username}  |  ордеров в БД: {orders.count()}")

    try:
        api = P2P(
            testnet=False,
            api_key=user.bybit_api_key,
            api_secret=user.bybit_api_secret,
        )
    except Exception as e:
        print(f"[!] Ошибка инициализации Bybit клиента: {e}")
        sys.exit(1)

    print("  Загружаем ордера с Bybit...")
    api_orders = fetch_all_bybit_orders(api, user.username)

    if api_orders is None:
        print("  [!] Не удалось загрузить данные с Bybit.")
        sys.exit(1)

    print(f"  Получено с Bybit API: {len(api_orders)} ордеров")
    print(f"  Сверяем с БД...\n")

    total_checked    = 0
    total_differ     = 0
    total_updated    = 0
    total_errors     = 0
    total_not_in_api = 0

    for order in orders:
        total_checked += 1

        api_data = api_orders.get(order.external_id)

        if api_data is None:
            print(f"  {order.external_id}  ->  НЕТ В API (пропускаем)")
            total_not_in_api += 1
            continue

        diffs = fields_differ(order, api_data)

        if not diffs:
            print(f"  {order.external_id}  ->  OK")
            continue

        total_differ += 1
        print(f"  {order.external_id}  ->  РАСХОЖДЕНИЕ:")
        for field, old_val, new_val in diffs:
            print(f"      {field}: {old_val}  =>  {new_val}")

        if DO_UPDATE:
            try:
                update_fields = []
                for field, _, new_val in diffs:
                    setattr(order, field, new_val)
                    update_fields.append(field)
                order.save(update_fields=update_fields)
                print(f"      [OK] Обновлено: {', '.join(update_fields)}")
                total_updated += 1
            except Exception as e:
                print(f"      [!] Ошибка сохранения: {e}")
                total_errors += 1

    print("\n" + "=" * 80)
    print(f"  Проверено:           {total_checked}")
    print(f"  Расхождений:         {total_differ}")
    print(f"  Обновлено:           {total_updated}")
    print(f"  Нет в API (старые):  {total_not_in_api}")
    print(f"  Ошибок:              {total_errors}")
    if not DO_UPDATE and total_differ > 0:
        print(f"\n  Запусти с --update чтобы применить изменения.")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()