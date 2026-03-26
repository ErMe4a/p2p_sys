"""
Запуск рядом с manage.py:

    # Диагностика — показывает что будет обновлено:
    python fix_orders_from_excel_mexc.py mexc_diff_2026-03-26.xlsx

    # Применить изменения:
    python fix_orders_from_excel_mexc.py mexc_diff_2026-03-26.xlsx --update

Читает Excel с расхождениями и обновляет только те ордера которые в нём указаны.
Берёт значения из колонки "На MEXC" (правильные данные с биржи).
"""

import os
import sys
import django
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")

try:
    django.setup()
except Exception as e:
    print(f"Ошибка инициализации Django: {e}")
    sys.exit(1)

import openpyxl
from orders.models import Order
from django.contrib.auth import get_user_model

User = get_user_model()
DO_UPDATE = "--update" in sys.argv

# Маппинг названий колонок на поля модели
FIELD_MAP = {
    "Сумма (руб)":      "cost",
    "Курс":             "price",
    "Кол-во (крипта)":  "amount",
    "Тип (BUY/SELL)":   "operation_type",
}

# Точность сохранения
DECIMAL_PLACES = {
    "cost":           2,
    "price":          2,
    "amount":         8,
    "operation_type": None,
}


def main():
    # Находим Excel файл
    xlsx_path = None
    for arg in sys.argv[1:]:
        if arg.endswith(".xlsx"):
            xlsx_path = arg
            break

    if not xlsx_path:
        print("Укажи файл: python fix_orders_from_excel_mexc.py mexc_diff_2026-03-26.xlsx")
        sys.exit(1)

    if not os.path.isabs(xlsx_path):
        xlsx_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), xlsx_path)

    if not os.path.exists(xlsx_path):
        print(f"Файл не найден: {xlsx_path}")
        sys.exit(1)

    print("=" * 80)
    if DO_UPDATE:
        print(f"  РЕЖИМ: ОБНОВЛЕНИЕ (--update)")
    else:
        print(f"  РЕЖИМ: ДИАГНОСТИКА (без изменений)")
        print(f"  Чтобы применить: python fix_orders_from_excel.py {os.path.basename(xlsx_path)} --update")
    print(f"  Файл: {xlsx_path}")
    print("=" * 80)

    # Читаем Excel
    wb = openpyxl.load_workbook(xlsx_path)
    ws = wb.active

    # Собираем данные: {(username, order_id): {field: new_value}}
    updates = {}

    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row[0] or not row[1] or not row[2]:
            continue

        username  = str(row[0]).strip()
        order_id  = str(row[1]).strip()
        field_label = str(row[2]).strip()
        new_value = row[4]  # колонка "На MEXC"

        if field_label not in FIELD_MAP:
            continue

        field = FIELD_MAP[field_label]
        key   = (username, order_id)

        if key not in updates:
            updates[key] = {}

        updates[key][field] = new_value

    print(f"\nИз Excel: {len(updates)} уникальных ордеров к обновлению\n")

    total_found   = 0
    total_updated = 0
    total_missing = 0

    for (username, order_id), fields in updates.items():
        # Ищем ордер в БД
        order = Order.objects.filter(
            user__username=username,
            external_id=order_id,
        ).first()

        if not order:
            print(f"  [{username}] {order_id}  ->  НЕ НАЙДЕН В БД")
            total_missing += 1
            continue

        total_found += 1
        print(f"  [{username}] {order_id}:")

        update_fields = []
        for field, new_val in fields.items():
            old_val = getattr(order, field)
            decimal_places = DECIMAL_PLACES.get(field)

            if decimal_places is not None:
                # Числовое поле
                new_decimal = Decimal(str(float(new_val or 0))).quantize(
                    Decimal("0." + "0" * decimal_places)
                )
                print(f"      {field}: {old_val}  =>  {new_decimal}")
                setattr(order, field, new_decimal)
            else:
                # Строковое поле (operation_type)
                new_str = str(new_val).strip().upper()
                print(f"      {field}: {old_val}  =>  {new_str}")
                setattr(order, field, new_str)

            update_fields.append(field)

        if DO_UPDATE and update_fields:
            try:
                order.save(update_fields=update_fields)
                print(f"      [OK] Сохранено")
                total_updated += 1
            except Exception as e:
                print(f"      [!] Ошибка сохранения: {e}")

    print("\n" + "=" * 80)
    print(f"  Найдено в БД:    {total_found}")
    print(f"  Обновлено:       {total_updated}")
    print(f"  Не найдено:      {total_missing}")
    if not DO_UPDATE and total_found > 0:
        print(f"\n  Запусти с --update чтобы применить.")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()
