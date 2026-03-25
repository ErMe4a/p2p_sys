"""
Запуск рядом с manage.py:

    # Диагностика — показывает расхождения без изменений:
    python sync_orders_bybit.py

    # Применить изменения:
    python sync_orders_bybit.py --update

Логика сравнения:
    price       — сравниваем до 2 знаков после запятой
    cost        — сравниваем до 2 знаков после запятой
    amount      — сравниваем до 3 знаков после запятой
    operation_type — точное совпадение

Комиссию, банк, скриншот, чек, дату — НЕ ТРОГАЕТ.
"""

import os
import sys
import django
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

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

# Точность сравнения для каждого поля
PRECISION = {
    "price":  Decimal("0.01"),    # 2 знака
    "cost":   Decimal("0.01"),    # 2 знака
    "amount": Decimal("0.001"),   # 3 знака
}


# ── Получение данных одного ордера с Bybit ────────────────────────────────────

def fetch_bybit_order(api, order_id: str):
    try:
        response = api.get_order_details(orderId=order_id)

        ret_code = response.get("ret_code")
        if ret_code is None:
            ret_code = response.get("retCode")

        if ret_code != 0:
            msg = response.get("ret_msg") or response.get("retMsg") or "unknown"
            return None, f"API error code={ret_code} msg={msg}"

        result = response.get("result") or {}
        item = result.get("order") or result or {}

        if not item:
            return None, "empty result"

        return item, None

    except Exception as e:
        return None, str(e)


def parse_bybit_item(item: dict) -> dict:
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


# ── Вспомогательные ───────────────────────────────────────────────────────────

def _to_decimal(value) -> Decimal:
    try:
        return Decimal(str(float(value or 0)))
    except Exception:
        return Decimal("0")


def _round(value, precision: Decimal) -> Decimal:
    """Округляет до нужной точности."""
    try:
        return Decimal(str(value or 0)).quantize(precision, rounding=ROUND_HALF_UP)
    except Exception:
        return Decimal("0")


def fields_differ(order: Order, api_data: dict) -> list:
    """
    Сравнивает поля с учётом точности:
      price, cost  — до 2 знаков
      amount       — до 3 знаков
    Возвращает список (field, old_val, new_val) только реальных расхождений.
    """
    diffs = []

    for field in ("price", "cost", "amount"):
        precision = PRECISION[field]
        db_val  = _round(getattr(order, field), precision)
        api_val = _round(api_data[field], precision)
        if db_val != api_val:
            diffs.append((field, getattr(order, field), api_data[field]))

    if order.operation_type != api_data["operation_type"]:
        diffs.append(("operation_type", order.operation_type, api_data["operation_type"]))

    return diffs


# ── Основная логика ───────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    if DO_UPDATE:
        print("  РЕЖИМ: ОБНОВЛЕНИЕ (--update)")
    else:
        print("  РЕЖИМ: ДИАГНОСТИКА (без изменений)")
        print("  Чтобы применить: python sync_orders_bybit.py --update")
    print("=" * 80)

    users = User.objects.filter(
        order__exchange_type__in=["Bybit", "BYBIT"]
    ).distinct()

    if not users.exists():
        print("\nНет пользователей с Bybit ордерами в Order.")
        return

    total_checked = 0
    total_differ  = 0
    total_updated = 0
    total_errors  = 0
    total_skipped = 0

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

        for order in orders:
            total_checked += 1

            item, error = fetch_bybit_order(api, order.external_id)

            if error:
                print(f"  {order.external_id}  ->  ОШИБКА: {error}")
                total_errors += 1
                time.sleep(0.2)
                continue

            api_data = parse_bybit_item(item)
            diffs = fields_differ(order, api_data)

            if not diffs:
                print(f"  {order.external_id}  ->  OK")
                time.sleep(0.15)
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

            time.sleep(0.15)

    print("\n" + "=" * 80)
    print(f"  Проверено:        {total_checked}")
    print(f"  Расхождений:      {total_differ}")
    print(f"  Обновлено:        {total_updated}")
    print(f"  Ошибок API:       {total_errors}")
    print(f"  Пропущено:        {total_skipped}")
    if not DO_UPDATE and total_differ > 0:
        print(f"\n  Запусти с --update чтобы применить изменения.")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()