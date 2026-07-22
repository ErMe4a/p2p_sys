# audit_orders_v2_smart.py
# READ-ONLY углублённый аудит за 2026 год. Ничего не меняет в БД.
# Запуск:  python manage.py shell < audit_orders_v2_smart.py

from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from statistics import median
from zoneinfo import ZoneInfo

from orders.models import Order
from django.contrib.auth import get_user_model

User = get_user_model()
MSK = ZoneInfo("Europe/Moscow")
YEAR = 2026
year_start = datetime(YEAR, 1, 1, tzinfo=MSK)
year_end = datetime(YEAR + 1, 1, 1, tzinfo=MSK)

def f(x):
    try:
        return float(x or 0)
    except Exception:
        return 0.0

qs = Order.objects.filter(created_at__gte=year_start, created_at__lt=year_end).order_by("created_at")
uid_to_name = {u.id: u.username for u in User.objects.all()}

print("=" * 70)
print(f"УГЛУБЛЁННЫЙ АУДИТ ({YEAR}) — курс / количество / комиссии / ручные ордера")
print("=" * 70)

orders = list(qs)
print(f"Загружено ордеров: {len(orders)}")

# ── 1. Рыночный курс дня (медиана price по USDT среди BUY+SELL с price>0) ──
price_by_day = defaultdict(list)
for o in orders:
    if o.currency != "USDT":
        continue
    price = f(getattr(o, "price", 0))
    if price <= 0:
        continue
    day = o.created_at.astimezone(MSK).date()
    price_by_day[day].append(price)

median_price_by_day = {day: median(vals) for day, vals in price_by_day.items() if len(vals) >= 5}

PRICE_DEVIATION_PCT = 15  # порог отклонения курса от медианы дня

price_outliers = []
for o in orders:
    if o.currency != "USDT":
        continue
    price = f(getattr(o, "price", 0))
    if price <= 0:
        continue
    day = o.created_at.astimezone(MSK).date()
    med = median_price_by_day.get(day)
    if med is None:
        continue
    dev_pct = abs(price - med) / med * 100
    if dev_pct > PRICE_DEVIATION_PCT:
        price_outliers.append((o, med, dev_pct))

print(f"\n[{len(price_outliers)}] КУРС СИЛЬНО ОТЛИЧАЕТСЯ ОТ РЫНОЧНОГО КУРСА ДНЯ (>{PRICE_DEVIATION_PCT}%)")
for o, med, dev in sorted(price_outliers, key=lambda x: -x[2])[:20]:
    name = uid_to_name.get(o.user_id, f"id{o.user_id}")
    print(f"    id={o.id} user={name} {o.operation_type} price={f(o.price):.2f} "
          f"(рынок дня≈{med:.2f}, откл {dev:.0f}%) amount={f(o.amount):.2f} "
          f"cost={f(o.cost):.2f} exch={o.exchange_type} @ {o.created_at.astimezone(MSK)}")
if len(price_outliers) > 20:
    print(f"    ... и ещё {len(price_outliers) - 20}")

# ── 2. Аномальное количество (относительно типичного размера сделки юзера) ──
amounts_by_user_cur = defaultdict(list)
for o in orders:
    amt = f(o.amount)
    if amt > 0:
        amounts_by_user_cur[(o.user_id, o.currency)].append(amt)

median_amt = {k: median(v) for k, v in amounts_by_user_cur.items() if len(v) >= 5}

AMOUNT_MULTIPLIER_HIGH = 5    # в 5+ раз больше типичного
AMOUNT_MULTIPLIER_LOW = 0.15  # меньше 15% от типичного (не пыль/сдача)

amount_outliers = []
for o in orders:
    amt = f(o.amount)
    if amt <= 0:
        continue
    key = (o.user_id, o.currency)
    med = median_amt.get(key)
    if med is None or med <= 0:
        continue
    ratio = amt / med
    if ratio > AMOUNT_MULTIPLIER_HIGH or ratio < AMOUNT_MULTIPLIER_LOW:
        amount_outliers.append((o, med, ratio))

print(f"\n[{len(amount_outliers)}] АНОМАЛЬНОЕ КОЛИЧЕСТВО (сильно отличается от типичной сделки юзера)")
for o, med, ratio in sorted(amount_outliers, key=lambda x: -abs(x[2] if x[2] > 1 else 1/x[2]))[:20]:
    name = uid_to_name.get(o.user_id, f"id{o.user_id}")
    print(f"    id={o.id} user={name} {o.operation_type} {o.currency} amount={f(o.amount):.4f} "
          f"(типично≈{med:.4f}, x{ratio:.1f}) cost={f(o.cost):.2f} exch={o.exchange_type} "
          f"@ {o.created_at.astimezone(MSK)}")
if len(amount_outliers) > 20:
    print(f"    ... и ещё {len(amount_outliers) - 20}")

# ── 3. exchange_commission_rate на BUY (должен быть только на SELL) ──
buy_with_exch_comm = []
for o in orders:
    if o.operation_type == "BUY":
        ecr = f(getattr(o, "exchange_commission_rate", 0))
        if ecr != 0:
            buy_with_exch_comm.append(o)

print(f"\n[{len(buy_with_exch_comm)}] КОМИССИЯ БИРЖИ ЗАПОЛНЕНА НА BUY (должна быть только на SELL — похоже на перепутанное поле)")
for o in buy_with_exch_comm[:20]:
    name = uid_to_name.get(o.user_id, f"id{o.user_id}")
    print(f"    id={o.id} user={name} BUY amount={f(o.amount):.4f} "
          f"exchange_commission_rate={f(o.exchange_commission_rate)} "
          f"commission={f(o.commission)}({o.commission_type}) @ {o.created_at.astimezone(MSK)}")
if len(buy_with_exch_comm) > 20:
    print(f"    ... и ещё {len(buy_with_exch_comm) - 20}")

# ── 4. Подозрительно большая комиссия банка (похоже на перепутанное поле биржи) ──
COMMISSION_PERCENT_CEILING = 5    # больше 5% для банковской комиссии нетипично
FIXED_COMMISSION_RATIO_CEILING = 0.10  # фикс. комиссия > 10% от cost — подозрительно

big_bank_comm = []
for o in orders:
    comm = f(getattr(o, "commission", 0))
    cost = f(o.cost)
    ct = getattr(o, "commission_type", None)
    if ct == "PERCENT" and 0 < comm <= 100 and comm > COMMISSION_PERCENT_CEILING:
        big_bank_comm.append((o, f"PERCENT={comm}%"))
    elif ct in ("MONEY", "RUB", "FIX") and cost > 0 and comm > cost * FIXED_COMMISSION_RATIO_CEILING:
        big_bank_comm.append((o, f"FIX={comm}₽ (это {comm/cost*100:.0f}% от cost={cost:.2f})"))

print(f"\n[{len(big_bank_comm)}] ПОДОЗРИТЕЛЬНО БОЛЬШАЯ КОМИССИЯ БАНКА (>{COMMISSION_PERCENT_CEILING}% или >{int(FIXED_COMMISSION_RATIO_CEILING*100)}% от cost — похоже на перепутанное поле)")
for o, desc in big_bank_comm[:20]:
    name = uid_to_name.get(o.user_id, f"id{o.user_id}")
    print(f"    id={o.id} user={name} {o.operation_type} {desc} "
          f"exch_comm_rate={f(o.exchange_commission_rate)} @ {o.created_at.astimezone(MSK)}")
if len(big_bank_comm) > 20:
    print(f"    ... и ещё {len(big_bank_comm) - 20}")

# ── 5. Ручные/Telegram ордера с рассогласованием cost vs amount*price ──
def is_manual_order(o):
    exch = (getattr(o, "exchange_type", "") or "").lower()
    ext = getattr(o, "external_id", "") or ""
    if "telegram" in exch:
        return True
    if ext.startswith("OB-") or ext.startswith("OS-"):
        return True
    return False

MANUAL_TOLERANCE = 0.02  # для ручных ордеров порог строже — 2%

manual_cost_mismatch = []
for o in orders:
    if not is_manual_order(o):
        continue
    amount = f(o.amount)
    price = f(getattr(o, "price", 0))
    cost = f(o.cost)
    if amount > 0 and price > 0 and cost > 0:
        expected = amount * price
        if expected > 0 and abs(cost - expected) / expected > MANUAL_TOLERANCE:
            manual_cost_mismatch.append((o, expected))

print(f"\n[{len(manual_cost_mismatch)}] РУЧНЫЕ ОРДЕРА (Telegram/OB-/OS-) С РАССОГЛАСОВАНИЕМ cost (>{int(MANUAL_TOLERANCE*100)}%) — высокий риск опечатки при вводе")
for o, expected in sorted(manual_cost_mismatch, key=lambda x: -abs(f(x[0].cost) - x[1]))[:20]:
    name = uid_to_name.get(o.user_id, f"id{o.user_id}")
    diff_pct = (f(o.cost) - expected) / expected * 100
    print(f"    id={o.id} user={name} {o.operation_type} amount={f(o.amount):.4f} price={f(o.price):.2f} "
          f"cost={f(o.cost):.2f} ожидалось≈{expected:.2f} ({diff_pct:+.0f}%) "
          f"ext={o.external_id} exch={o.exchange_type} @ {o.created_at.astimezone(MSK)}")
if len(manual_cost_mismatch) > 20:
    print(f"    ... и ещё {len(manual_cost_mismatch) - 20}")

# ── 6. Явный паттерн "все три поля равны" (amount=price=cost) — типичный фейк-ввод ──
triple_equal = []
for o in orders:
    amount = f(o.amount)
    price = f(getattr(o, "price", 0))
    cost = f(o.cost)
    if amount > 0 and amount == price == cost:
        triple_equal.append(o)

print(f"\n[{len(triple_equal)}] ORDER С amount == price == cost (явный признак битого/тестового ввода)")
for o in triple_equal[:20]:
    name = uid_to_name.get(o.user_id, f"id{o.user_id}")
    print(f"    id={o.id} user={name} {o.operation_type} {o.currency} значение={f(o.amount)} @ {o.created_at.astimezone(MSK)}")
if len(triple_equal) > 20:
    print(f"    ... и ещё {len(triple_equal) - 20}")

print("\n" + "=" * 70)
print("СВОДКА ПО КАТЕГОРИЯМ:")
print(f"  1. Курс далёк от рыночного:            {len(price_outliers)}")
print(f"  2. Аномальное количество:               {len(amount_outliers)}")
print(f"  3. Комиссия биржи на BUY:                {len(buy_with_exch_comm)}")
print(f"  4. Подозрительно большая комиссия банка: {len(big_bank_comm)}")
print(f"  5. Ручные ордера с рассогласованием cost:{len(manual_cost_mismatch)}")
print(f"  6. amount==price==cost (битый ввод):     {len(triple_equal)}")
print("=" * 70)
print("Аудит завершён. БД не изменялась.")
print("=" * 70)