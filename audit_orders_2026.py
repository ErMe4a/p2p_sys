# audit_orders_excel_report.py
# READ-ONLY. Строит Excel-отчёт по аномалиям ордеров за 2026 год.
# Ничего не меняет в БД, только читает и пишет .xlsx на диск.
#
# Запуск:  python manage.py shell < audit_orders_excel_report.py
# Результат: /tmp/audit_report_2026.xlsx  (скачай его к себе для просмотра)

from collections import defaultdict
from datetime import datetime
from statistics import median

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from zoneinfo import ZoneInfo

from orders.models import Order
from django.contrib.auth import get_user_model

User = get_user_model()
MSK = ZoneInfo("Europe/Moscow")
YEAR = 2026
year_start = datetime(YEAR, 1, 1, tzinfo=MSK)
year_end = datetime(YEAR + 1, 1, 1, tzinfo=MSK)

OUTPUT_PATH = "/tmp/audit_report_2026.xlsx"

def f(x):
    try:
        return float(x or 0)
    except Exception:
        return 0.0

print("Загружаю ордера из БД...")
orders = list(Order.objects.filter(created_at__gte=year_start, created_at__lt=year_end).order_by("created_at"))
uid_to_name = {u.id: u.username for u in User.objects.all()}
print(f"Загружено: {len(orders)}")

# ============================================================
# 1. КУРС: своя медиана дня ДЛЯ КАЖДОЙ ВАЛЮТЫ ОТДЕЛЬНО (USDT и TON не смешиваются)
# ============================================================
price_by_day_cur = defaultdict(list)
for o in orders:
    price = f(getattr(o, "price", 0))
    if price <= 0:
        continue
    day = o.created_at.astimezone(MSK).date()
    price_by_day_cur[(o.currency, day)].append(price)

median_price = {k: median(v) for k, v in price_by_day_cur.items() if len(v) >= 3}

PRICE_DEVIATION_PCT = 15
price_outliers = []
for o in orders:
    price = f(getattr(o, "price", 0))
    if price <= 0:
        continue
    day = o.created_at.astimezone(MSK).date()
    med = median_price.get((o.currency, day))
    if med is None:
        continue
    dev_pct = abs(price - med) / med * 100
    if dev_pct > PRICE_DEVIATION_PCT:
        price_outliers.append((o, med, dev_pct))

# ============================================================
# 2. КОЛИЧЕСТВО: percentile-метод (p95 * 10), исключая нач. остаток,
#    отдельно по (user, currency) - не путаем USDT и TON
# ============================================================
amounts_by_user_cur = defaultdict(list)
for o in orders:
    if (getattr(o, "exchange_type", "") or "") == "Остаток (до 1 фев)":
        continue  # легитимный разовый перенос остатка, не для базовой линии
    amt = f(o.amount)
    if amt > 0:
        amounts_by_user_cur[(o.user_id, o.currency)].append(amt)

p95_by_user_cur = {}
for key, vals in amounts_by_user_cur.items():
    if len(vals) >= 10:  # нужно достаточно сделок для устойчивого перцентиля
        s = sorted(vals)
        p95_by_user_cur[key] = s[int(len(s) * 0.95)]

AMOUNT_MULTIPLIER = 10  # порог: экстремальный хвост ЗА ПРЕДЕЛАМИ обычного разброса юзера (p95)
amount_outliers = []
for o in orders:
    if (getattr(o, "exchange_type", "") or "") == "Остаток (до 1 фев)":
        continue
    amt = f(o.amount)
    if amt <= 0:
        continue
    key = (o.user_id, o.currency)
    p95 = p95_by_user_cur.get(key)
    if p95 is None or p95 <= 0:
        continue
    if amt > p95 * AMOUNT_MULTIPLIER:
        amount_outliers.append((o, p95, amt / p95))

# ============================================================
# 3. exchange_commission_rate на BUY - ПОДТВЕРЖДЕНО КОДОМ: НЕ ВЛИЯЕТ НА РАСЧЁТЫ.
#    Ставится автоматически при создании любого ордера (снимок комиссии биржи
#    на момент сделки), используется только для SELL. Оставляем ИНФОРМАЦИОННО.
# ============================================================
buy_with_exch_comm_by_user = defaultdict(int)
for o in orders:
    if o.operation_type == "BUY" and f(getattr(o, "exchange_commission_rate", 0)) != 0:
        buy_with_exch_comm_by_user[o.user_id] += 1

# ============================================================
# 4. Подозрительно большая комиссия банка
# ============================================================
COMMISSION_PERCENT_CEILING = 5
FIXED_COMMISSION_RATIO_CEILING = 0.10
big_bank_comm = []
for o in orders:
    comm = f(getattr(o, "commission", 0))
    cost = f(o.cost)
    ct = getattr(o, "commission_type", None)
    if ct == "PERCENT" and 0 < comm <= 100 and comm > COMMISSION_PERCENT_CEILING:
        big_bank_comm.append((o, f"PERCENT={comm}%"))
    elif ct in ("MONEY", "RUB", "FIX") and cost > 0 and comm > cost * FIXED_COMMISSION_RATIO_CEILING:
        big_bank_comm.append((o, f"FIX={comm}руб ({comm/cost*100:.0f}% от cost)"))

# ============================================================
# 5. Ручные ордера (Telegram/OB-/OS-) с рассогласованием cost
# ============================================================
def is_manual_order(o):
    exch = (getattr(o, "exchange_type", "") or "").lower()
    ext = getattr(o, "external_id", "") or ""
    if "telegram" in exch:
        return True
    if ext.startswith("OB-") or ext.startswith("OS-"):
        return True
    return False

MANUAL_TOLERANCE = 0.02
manual_cost_mismatch = []
for o in orders:
    if not is_manual_order(o):
        continue
    amount = f(o.amount); price = f(getattr(o, "price", 0)); cost = f(o.cost)
    if amount > 0 and price > 0 and cost > 0:
        expected = amount * price
        if expected > 0 and abs(cost - expected) / expected > MANUAL_TOLERANCE:
            manual_cost_mismatch.append((o, expected))

# ============================================================
# 6. amount == price == cost (битый/тестовый ввод)
# ============================================================
triple_equal = []
for o in orders:
    amount = f(o.amount); price = f(getattr(o, "price", 0)); cost = f(o.cost)
    if amount > 0 and amount == price == cost:
        triple_equal.append(o)

# ============================================================
# ЗАПИСЬ В EXCEL
# ============================================================
print("Формирую Excel-отчёт...")
wb = Workbook()

HEADER_FILL = PatternFill(start_color="2C3E50", end_color="2C3E50", fill_type="solid")
HEADER_FONT = Font(bold=True, color="FFFFFF")
RISK_HIGH = PatternFill(start_color="F5B7B1", end_color="F5B7B1", fill_type="solid")
RISK_LOW = PatternFill(start_color="D5F5E3", end_color="D5F5E3", fill_type="solid")

def style_header(ws, row=1):
    for cell in ws[row]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center")

def autosize(ws):
    for col_cells in ws.columns:
        length = max((len(str(c.value)) if c.value is not None else 0) for c in col_cells)
        col_letter = get_column_letter(col_cells[0].column)
        ws.column_dimensions[col_letter].width = min(max(length + 2, 10), 60)

# ── Лист 0: Сводка ──
ws0 = wb.active
ws0.title = "Сводка"
ws0.append(["Категория", "Кол-во", "Риск", "Комментарий"])
style_header(ws0)
summary_rows = [
    ("1. Курс сильно отличается от рынка дня (USDT+TON раздельно)", len(price_outliers), "Высокий",
     f">{PRICE_DEVIATION_PCT}% откл. от медианы дня по своей валюте"),
    ("2. Аномальное количество (экстрим за пределами обычного для юзера)", len(amount_outliers), "Высокий",
     f"percentile-метод: >{AMOUNT_MULTIPLIER}x от p95 юзера, искл. нач. остаток"),
    ("3. Комиссия биржи проставлена на BUY", sum(buy_with_exch_comm_by_user.values()), "НЕ ВЛИЯЕТ",
     "Подтверждено кодом: ставится системой всегда, используется только для SELL. Не аномалия."),
    ("4. Подозрительно большая комиссия банка", len(big_bank_comm), "Средний",
     f">{COMMISSION_PERCENT_CEILING}% или >{int(FIXED_COMMISSION_RATIO_CEILING*100)}% от cost"),
    ("5. Ручные ордера (Telegram/OB-/OS-) с расхождением cost", len(manual_cost_mismatch), "Высокий",
     f">{int(MANUAL_TOLERANCE*100)}% расхождение cost vs amount*price - высокий риск опечатки"),
    ("6. amount == price == cost (битый ввод)", len(triple_equal), "Высокий", "Явный признак тестовых/битых данных"),
]
for row in summary_rows:
    ws0.append(row)
autosize(ws0)

# ── Лист 1: Курс USDT ──
ws1 = wb.create_sheet("Курс USDT")
ws1.append(["ID", "Пользователь", "Тип", "Курс ордера", "Медиана дня", "Откл. %", "Кол-во", "Сумма", "Биржа", "Дата"])
style_header(ws1)
for o, med, dev in sorted([x for x in price_outliers if x[0].currency == "USDT"], key=lambda x: -x[2]):
    ws1.append([o.id, uid_to_name.get(o.user_id, o.user_id), o.operation_type, round(f(o.price), 2),
                round(med, 2), round(dev, 0), round(f(o.amount), 4), round(f(o.cost), 2),
                o.exchange_type, o.created_at.astimezone(MSK).strftime("%d.%m.%Y %H:%M")])
autosize(ws1)

# ── Лист 2: Курс TON ──
ws2 = wb.create_sheet("Курс TON")
ws2.append(["ID", "Пользователь", "Тип", "Курс ордера", "Медиана дня", "Откл. %", "Кол-во", "Сумма", "Биржа", "Дата"])
style_header(ws2)
for o, med, dev in sorted([x for x in price_outliers if x[0].currency == "TON"], key=lambda x: -x[2]):
    ws2.append([o.id, uid_to_name.get(o.user_id, o.user_id), o.operation_type, round(f(o.price), 4),
                round(med, 4), round(dev, 0), round(f(o.amount), 4), round(f(o.cost), 2),
                o.exchange_type, o.created_at.astimezone(MSK).strftime("%d.%m.%Y %H:%M")])
autosize(ws2)

# ── Лист 3: Аномальное количество ──
ws3 = wb.create_sheet("Аномальное кол-во")
ws3.append(["ID", "Пользователь", "Валюта", "Тип", "Кол-во", "p95 юзера", "Во сколько раз больше", "Сумма", "Биржа", "Дата"])
style_header(ws3)
for o, p95, ratio in sorted(amount_outliers, key=lambda x: -x[2]):
    ws3.append([o.id, uid_to_name.get(o.user_id, o.user_id), o.currency, o.operation_type,
                round(f(o.amount), 4), round(p95, 4), round(ratio, 1), round(f(o.cost), 2),
                o.exchange_type, o.created_at.astimezone(MSK).strftime("%d.%m.%Y %H:%M")])
autosize(ws3)

# ── Лист 4: Комиссия банка ──
ws4 = wb.create_sheet("Большая комиссия банка")
ws4.append(["ID", "Пользователь", "Тип", "Описание", "Комиссия биржи (справочно)", "Дата"])
style_header(ws4)
for o, desc in big_bank_comm:
    ws4.append([o.id, uid_to_name.get(o.user_id, o.user_id), o.operation_type, desc,
                f(o.exchange_commission_rate), o.created_at.astimezone(MSK).strftime("%d.%m.%Y %H:%M")])
autosize(ws4)

# ── Лист 5: Ручные ордера ──
ws5 = wb.create_sheet("Ручные ордера (cost)")
ws5.append(["ID", "Пользователь", "Тип", "Кол-во", "Курс", "Cost факт", "Cost ожидаемый", "Откл. %", "External ID", "Биржа", "Дата"])
style_header(ws5)
for o, expected in sorted(manual_cost_mismatch, key=lambda x: -abs(f(x[0].cost) - x[1])):
    diff_pct = (f(o.cost) - expected) / expected * 100
    ws5.append([o.id, uid_to_name.get(o.user_id, o.user_id), o.operation_type, round(f(o.amount), 4),
                round(f(o.price), 2), round(f(o.cost), 2), round(expected, 2), round(diff_pct, 0),
                o.external_id, o.exchange_type, o.created_at.astimezone(MSK).strftime("%d.%m.%Y %H:%M")])
autosize(ws5)

# ── Лист 6: Triple equal ──
ws6 = wb.create_sheet("Битый ввод (a=p=c)")
ws6.append(["ID", "Пользователь", "Валюта", "Тип", "Значение", "Дата"])
style_header(ws6)
for o in triple_equal:
    ws6.append([o.id, uid_to_name.get(o.user_id, o.user_id), o.currency, o.operation_type,
                f(o.amount), o.created_at.astimezone(MSK).strftime("%d.%m.%Y %H:%M")])
autosize(ws6)

# ── Лист 7: Комиссия биржи на BUY (информационно, по юзерам) ──
ws7 = wb.create_sheet("Комса биржи на BUY (инфо)")
ws7.append(["Пользователь", "Кол-во BUY-ордеров с exchange_commission_rate != 0"])
style_header(ws7)
ws7.append(["ПРИМЕЧАНИЕ: это НЕ аномалия — поле проставляется системой автоматически", ""])
ws7.append(["на все ордера (снимок комиссии биржи), но используется в расчётах ТОЛЬКО для SELL.", ""])
for uid, cnt in sorted(buy_with_exch_comm_by_user.items(), key=lambda x: -x[1]):
    ws7.append([uid_to_name.get(uid, uid), cnt])
autosize(ws7)

wb.save(OUTPUT_PATH)
print(f"\nГотово! Отчёт сохранён: {OUTPUT_PATH}")
print(f"Скачай его командой (с локальной машины): scp ubuntu@<сервер>:{OUTPUT_PATH} .")
print("БД не изменялась.")