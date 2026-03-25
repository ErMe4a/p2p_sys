"""
Запуск рядом с manage.py:

    # Диагностика — показывает расхождения без изменений:
    python sync_orders_bybit.py

    # Применить изменения:
    python sync_orders_bybit.py --update

Проверяет всех пользователей у которых есть Bybit ордера и API ключи.
Показывает расхождение только если разница > 1 по любому из полей.
Ордера с 01.02.2026 по сегодня.

Точность сравнения:
    price, cost  — до 2 знаков
    amount       — до 3 знаков

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

DATE_FROM_MS = int(datetime(2026, 2, 1).timestamp() * 1000)

# Порог расхождения — показываем только если разница > этого значения
DIFF_THRESHOLD = Decimal("1")

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
        if abs(db_val - api_val) > DIFF_THRESHOLD:
            diffs.append((field, getattr(order, field), api_data[field]))
    if order.operation_type != api_data["operation_type"]:
        diffs.append(("operation_type", order.operation_type, api_data["operation_type"]))
    return diffs


def main():
    print("=" * 80)
    if DO_UPDATE:
        print("  РЕЖИМ: ОБНОВЛЕНИЕ (--update)")
    else:
        print("  РЕЖИМ: ДИАГНОСТИКА (без изменений)")
        print("  Чтобы применить: python sync_orders_bybit.py --update")
    print(f"  Порог расхождения: > {DIFF_THRESHOLD}  |  Ордера с 01.02.2026")
    print("=" * 80)

    users = User.objects.filter(
        order__exchange_type__in=["Bybit", "BYBIT"]
    ).distinct()

    if not users.exists():
        print("\nНет пользователей с Bybit ордерами.")
        return

    total_checked    = 0
    total_differ     = 0
    total_updated    = 0
    total_errors     = 0
    total_skipped    = 0
    total_not_in_api = 0

    for user in users:
        has_keys = bool(
            getattr(user, "bybit_api_key", None)
            and getattr(user, "bybit_api_secret", None)
        )

        orders = (
            Order.objects
            .filter(user=user, exchange_type__in=["Bybit", "BYBIT"])
            .exclude(external_id="")
            .exclude(external_id__isnull=True)
            .order_by("-created_at")
        )

        count = orders.count()
        print(f"\nПользователь: {user.username}  "
              f"[{'ключи есть' if has_keys else 'КЛЮЧЕЙ НЕТ'}]  "
              f"ордеров в БД: {count}")

        if not has_keys:
            total_skipped += count
            print("  Пропускаем (нет API ключей Bybit)")
            continue

        try:
            api = P2P(
                testnet=False,
                api_key=user.bybit_api_key,
                api_secret=user.bybit_api_secret,
            )
        except Exception as e:
            print(f"  [!] Ошибка инициализации Bybit клиента: {e}")
            total_skipped += count
            continue

        print("  Загружаем ордера с Bybit...")
        api_orders = fetch_all_bybit_orders(api, user.username)

        if api_orders is None:
            print("  [!] Не удалось загрузить данные с Bybit — пропускаем")
            total_skipped += count
            continue

        print(f"  Получено с Bybit API: {len(api_orders)} ордеров")
        print(f"  Сверяем с БД...")

        for order in orders:
            total_checked += 1

            api_data = api_orders.get(order.external_id)

            if api_data is None:
                total_not_in_api += 1
                continue

            diffs = fields_differ(order, api_data)

            if not diffs:
                continue

            total_differ += 1
            print(f"  {order.external_id}  ->  РАСХОЖДЕНИЕ:")
            for field, old_val, new_val in diffs:
                diff = abs(_round(old_val, PRECISION.get(field, Decimal("0.01"))) -
                           _round(new_val, PRECISION.get(field, Decimal("0.01"))))
                print(f"      {field}: {old_val}  =>  {new_val}  (разница: {diff})")

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
    print(f"  Расхождений > 1:     {total_differ}")
    print(f"  Обновлено:           {total_updated}")
    print(f"  Нет в API (старые):  {total_not_in_api}")
    print(f"  Ошибок:              {total_errors}")
    print(f"  Пропущено:           {total_skipped}")
    if not DO_UPDATE and total_differ > 0:
        print(f"\n  Запусти с --update чтобы применить изменения.")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()