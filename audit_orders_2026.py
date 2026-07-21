# audit_orders_2026.py
# READ-ONLY аудит ордеров за 2026 год. Ничего не меняет в БД.
# Запуск:  python manage.py shell < audit_orders_2026.py
#   либо скопировать целиком в  python manage.py shell

from collections import defaultdict, Counter
from datetime import datetime
from zoneinfo import ZoneInfo

from orders.models import Order
from django.contrib.auth import get_user_model

User = get_user_model()
MSK = ZoneInfo("Europe/Moscow")

YEAR = 2026
year_start = datetime(YEAR, 1, 1, tzinfo=MSK)
year_end = datetime(YEAR + 1, 1, 1, tzinfo=MSK)

# Порог согласованности cost vs amount*price (в долях): 1% расхождения
COST_TOLERANCE = 0.01

qs = Order.objects.filter(created_at__gte=year_start, created_at__lt=year_end).order_by("user_id", "created_at")

total = qs.count()
print("=" * 70)
print(f"АУДИТ ОРДЕРОВ ЗА {YEAR} ГОД  (read-only, БД не меняется)")
print(f"Всего ордеров за период: {total}")
print("=" * 70)

def f(x):
    try:
        return float(x or 0)
    except Exception:
        return 0.0

# ── Аккумуляторы находок ────────────────────────────────────────────
issues = defaultdict(list)          # тип проблемы -> список описаний
per_user_counts = Counter()         # user_id -> число ордеров
per_user_issues = Counter()         # user_id -> число проблемных ордеров
exch_types = Counter()
currencies = Counter()
op_types = Counter()
comm_types = Counter()

# для поиска дублей
by_extid = defaultdict(list)        # (user_id, external_id) -> [order ids]
by_signature = defaultdict(list)    # (user_id, ts, op, amount, cost) -> [order ids]

# для баланса по валютам на юзера
bal = defaultdict(lambda: defaultdict(lambda: {"buy": 0.0, "sell": 0.0, "exch": 0.0}))

now = datetime.now(MSK)

for o in qs:
    uid = o.user_id
    per_user_counts[uid] += 1
    flagged = False

    amount = f(o.amount)
    cost = f(o.cost)
    price = f(getattr(o, "price", 0))
    op = getattr(o, "operation_type", None)
    cur = getattr(o, "currency", None)
    ct = getattr(o, "commission_type", None)
    ext = getattr(o, "external_id", None)
    exch = getattr(o, "exchange_type", "") or ""

    op_types[op] += 1
    currencies[cur] += 1
    comm_types[ct] += 1
    exch_types[exch] += 1

    tag = f"id={o.id} user={uid} {op} {cur} amount={amount} cost={cost} price={price} @ {o.created_at}"

    # 1. Нулевые/битые количества и суммы
    if amount == 0:
        issues["amount = 0"].append(tag); flagged = True
    if amount < 0:
        issues["amount < 0 (отрицательное кол-во)"].append(tag); flagged = True
    if cost == 0 and amount != 0:
        issues["cost = 0 при amount != 0"].append(tag); flagged = True
    if cost < 0:
        issues["cost < 0"].append(tag); flagged = True
    if price < 0:
        issues["price < 0"].append(tag); flagged = True

    # 2. Согласованность cost и amount*price (если оба заданы)
    if amount > 0 and price > 0 and cost > 0:
        expected = amount * price
        if expected > 0 and abs(cost - expected) / expected > COST_TOLERANCE:
            diff_pct = (cost - expected) / expected * 100
            issues["cost != amount*price (>1%)"].append(
                f"{tag}  ожидалось≈{expected:.2f} ({diff_pct:+.1f}%)"
            ); flagged = True

    # 3. Тип операции вне BUY/SELL
    if op not in ("BUY", "SELL"):
        issues["operation_type не BUY/SELL"].append(tag); flagged = True

    # 4. Валюта вне ожидаемых
    if cur not in ("USDT", "TON"):
        issues["currency не USDT/TON"].append(f"{tag}  currency={cur!r}"); flagged = True

    # 5. Дата в будущем
    if o.created_at > now:
        issues["дата в будущем"].append(tag); flagged = True

    # 6. Комиссия: тип PERCENT, но значение подозрительно велико (>100)
    comm = f(getattr(o, "commission", 0))
    if ct == "PERCENT" and comm > 100:
        issues["commission PERCENT > 100%"].append(f"{tag}  commission={comm}"); flagged = True
    if comm < 0:
        issues["commission < 0"].append(f"{tag}  commission={comm}"); flagged = True

    # 7. exchange_commission_rate подозрительный
    ecr = f(getattr(o, "exchange_commission_rate", 0))
    if ecr < 0 or ecr > 100:
        issues["exchange_commission_rate вне [0..100]"].append(f"{tag}  ecr={ecr}"); flagged = True

    # ── сбор для дублей ──
    if ext:
        by_extid[(uid, ext)].append(o.id)
    ts_min = o.created_at.replace(second=0, microsecond=0)
    sig = (uid, ts_min, op, round(amount, 6), round(cost, 2))
    by_signature[sig].append(o.id)

    # ── баланс по валюте ──
    if op == "BUY":
        bal[uid][cur]["buy"] += amount
    elif op == "SELL":
        bal[uid][cur]["sell"] += amount
        bal[uid][cur]["exch"] += amount * ecr / 100

    if flagged:
        per_user_issues[uid] += 1

# 8. Дубли по external_id
for (uid, ext), ids in by_extid.items():
    if len(ids) > 1:
        issues["ДУБЛЬ по external_id"].append(f"user={uid} external_id={ext!r} -> ордера {ids}")

# 9. Похожие дубли по сигнатуре (тот же юзер/минута/операция/кол-во/сумма)
for sig, ids in by_signature.items():
    if len(ids) > 1:
        uid, ts, op, amount, cost = sig
        issues["ВОЗМОЖНЫЙ ДУБЛЬ (та же минута/кол-во/сумма)"].append(
            f"user={uid} {op} {amount} на {cost} @ {ts} -> ордера {ids}"
        )

# 10. Перекос BUY/SELL: продано+комса больше, чем куплено (остаток в минус)
for uid, curs in bal.items():
    for cur, d in curs.items():
        remainder = d["buy"] - d["sell"] - d["exch"]
        # начальный остаток "до 1 фев" тут не учтён — это лишь сигнал, не приговор
        if remainder < -0.01:
            issues["остаток по валюте в МИНУСЕ (без учёта нач. остатка)"].append(
                f"user={uid} {cur}: buy={d['buy']:.4f} sell={d['sell']:.4f} "
                f"exch={d['exch']:.4f} -> остаток={remainder:.4f}"
            )

# ── ВЫВОД ───────────────────────────────────────────────────────────
print("\nСВОДКА ПО ЗНАЧЕНИЯМ ПОЛЕЙ:")
print(f"  operation_type: {dict(op_types)}")
print(f"  currency:       {dict(currencies)}")
print(f"  commission_type:{dict(comm_types)}")
print(f"  exchange_type (топ-10): {exch_types.most_common(10)}")

print("\nОРДЕРОВ ПО ПОЛЬЗОВАТЕЛЯМ:")
uid_to_name = {u.id: u.username for u in User.objects.all()}
for uid, cnt in per_user_counts.most_common():
    name = uid_to_name.get(uid, f"id{uid}")
    bad = per_user_issues.get(uid, 0)
    mark = f"  ⚠ проблемных: {bad}" if bad else ""
    print(f"  {name:20s} ордеров: {cnt}{mark}")

print("\n" + "=" * 70)
print("НАЙДЕННЫЕ АНОМАЛИИ:")
print("=" * 70)
if not issues:
    print("✅ Аномалий не обнаружено.")
else:
    for kind, items in sorted(issues.items(), key=lambda kv: -len(kv[1])):
        print(f"\n[{len(items)}] {kind}")
        for line in items[:15]:      # первые 15 на каждый тип, чтобы не залить экран
            print(f"    - {line}")
        if len(items) > 15:
            print(f"    ... и ещё {len(items) - 15}")

print("\n" + "=" * 70)
print("Аудит завершён. БД не изменялась.")
print("=" * 70)