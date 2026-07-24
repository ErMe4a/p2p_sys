# AUDIT_PLAN.md

Read-only Django ORM checks to run **on the production server**, against the real database, to confirm or refute
the findings from the code-level review (see chat / commit notes). Nothing here writes to the database — every
block only reads and prints. Adjust `/opt/p2p_sys` to the actual deploy path and the venv location before running.

General pattern:

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
# ORM code here
"
```

Run these in the order given — later checks assume you already know the scale of duplicates/unverified orders
from the earlier ones. Where a check prints a count first, look at that before dumping full rows.

---

## 1. Duplicate orders (no DB-level uniqueness constraint exists on Order)

`orders/models.py` — `Order.Meta` only defines indexes, not a `unique_together` on
`(user, external_id, exchange_type)` (unlike `UnprocessedOrder` and `IgnoredOrder`, which do have it). Combined
with the create-or-update path in `api_views.order()` doing a plain `get()`/`create()` instead of
`get_or_create()`, two near-simultaneous requests for the same exchange order can both fail the `get()` and both
insert a row.

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from django.db.models import Count
from orders.models import Order

dups = (Order.objects.values('user_id', 'external_id', 'exchange_type')
        .annotate(c=Count('id')).filter(c__gt=1).order_by('-c'))
print('DUPLICATE GROUPS:', dups.count())
for d in dups[:50]:
    print(d)
"
```

**Norm:** 0 groups. **Signal:** any group with `c > 1` is the same real-world trade counted (and potentially
fiscalized) more than once — it inflates turnover/gross in every report that sums `Order.objects.filter(...)`
without deduplicating.

---

## 2. Unverified / verification-failed orders that still feed the reports

None of `export_excel_report`, `admin_profit_view`, `api_user_yearly_profit`, or `nds_generator.py` filter on
`is_verified` or on `receipt.verification_failed` — they query `Order.objects.filter(created_at__gte=..., ...)`
directly. This means data that only ever came from the browser extension's scrape (never confirmed against the
exchange API) can end up in the tax/profit numbers.

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from django.db.models import Q
from orders.models import Order

qs = Order.objects.filter(Q(is_verified=False) | Q(receipt__verification_failed=True))
print('UNVERIFIED / FAILED TOTAL:', qs.count())
nonzero = qs.exclude(cost=0)
print('...of which have nonzero cost (they DO move report totals):', nonzero.count())
for o in nonzero.order_by('-created_at')[:30]:
    print(o.id, o.user_id, o.exchange_type, o.external_id, o.operation_type,
          o.price, o.amount, o.cost, 'verified=', o.is_verified, 'manual=', o.is_manual)
"
```

**Norm:** the `nonzero` count should be 0, or every row on it should be `is_manual=True` (deliberate operator
entry, acceptable). **Signal:** any non-manual, non-zero-cost row here is a number sitting inside your profit/tax
totals that was never confirmed against Bybit/MEXC and has no exchange-side backing.

---

## 3. Zero / negative / structurally invalid amounts

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from django.db.models import Q
from orders.models import Order

bad = Order.objects.filter(Q(price__lte=0) | Q(amount__lte=0) | Q(cost__lte=0))
print('BAD ORDERS:', bad.count())
for o in bad.order_by('-created_at')[:30]:
    print(o.id, o.user_id, o.exchange_type, o.external_id,
          o.price, o.amount, o.cost, 'verified=', o.is_verified, 'receipt=', o.receipt)
"
```

**Norm:** 0, or only very old test/seed rows. **Signal:** any recent row — `evotor_atol.build_receipt_payload_v5`
silently substitutes `1.0` for a zero `amount` or `cost` before building the receipt (see `raw_quantity`/
`raw_total_sum` fallback), so a zero here is not just a display bug, it can become a fabricated "1 unit" line item
on an actual fiscal receipt.

---

## 4. `price × amount` vs `cost` reconciliation

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from decimal import Decimal
from orders.models import Order

TOL = Decimal('0.02')  # 2% tolerance
bad = []
for o in Order.objects.filter(price__gt=0, amount__gt=0, cost__gt=0).iterator():
    expected = o.price * o.amount
    diff = abs(expected - o.cost)
    if o.cost and diff / o.cost > TOL:
        bad.append((o.id, o.user_id, o.external_id, o.exchange_type,
                     float(o.price), float(o.amount), float(o.cost), float(expected)))
print('MISMATCHES > 2%:', len(bad))
for row in bad[:30]:
    print(row)
"
```

**Norm:** near-zero mismatches (small rounding is expected — MEXC/Bybit numbers get derived one from another when
one field is missing, see `exchange_api.py`). **Signal:** many rows or large diffs — means `price`, `amount`,
`cost` were populated from three different sources/times rather than one consistent snapshot (e.g. manual edit
touched one field but not the others).

---

## 5. Currency hygiene

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from orders.models import Order
print(list(Order.objects.exclude(currency__in=['USDT', 'TON']).values('currency').distinct()))
print('count outside USDT/TON:', Order.objects.exclude(currency__in=['USDT', 'TON']).count())
"
```

**Norm:** empty list, 0 count — `_calc_currency` / `_calc_currency_from_orders` in `views.py` only ever compute
`USDT` and `TON` buckets; anything else is silently excluded from every profit/tax report while still sitting in
the DB (and possibly counted in turnover views that don't filter by currency, e.g. `api_get_turnover`).

---

## 6. Orders edited AFTER the fiscal receipt was already sent (the most important check)

`receipt_service.create_or_update_and_send_receipt` freezes `price`/`sum`/`amount` into `order.receipt` at the
moment the receipt is sent (`orders/receipt_service.py:103-112`). `Order.price`/`amount`/`cost` can be freely
edited afterwards via `edit_order` (user-facing) or `admin_orders_editor` (`save_order` branch) with **no**
re-verification, no reset of `is_verified`, and — because `Order` has no `updated_at` column — no other way to
detect the edit happened. Comparing the live fields against the frozen receipt snapshot is the only way to catch
this from the DB alone.

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from orders.models import Order

mismatched = []
qs = Order.objects.exclude(receipt__uuid__isnull=True).exclude(receipt={})
for o in qs.iterator():
    r = o.receipt or {}
    if not r.get('uuid'):
        continue
    try:
        r_price  = float(r.get('price')  or 0)
        r_sum    = float(r.get('sum')    or 0)
        r_amount = float(r.get('amount') or 0)
    except (TypeError, ValueError):
        continue
    if (abs(r_price - float(o.price)) > 0.01
            or abs(r_sum - float(o.cost)) > 0.01
            or abs(r_amount - float(o.amount)) > 0.00000001):
        mismatched.append((o.id, o.user_id, o.external_id, o.exchange_type,
                            'receipt:', r_price, r_sum, r_amount,
                            'now:', float(o.price), float(o.cost), float(o.amount)))
print('POST-FISCALIZATION EDITS DETECTED:', len(mismatched))
for row in mismatched[:50]:
    print(row)
"
```

**Norm:** 0. **Signal:** every row here is an order where the number on the real fiscal receipt (already sent to
Evotor/the tax authority's OFD) no longer matches what your own reports/exports will show for that order. This is
a direct receipt-vs-report divergence — treat any hit as a compliance issue, not a bug ticket.

---

## 7. Direct check of the "never fiscalize unverified data" invariant

**IMPORTANT — confirmed against a real run (2026-07-25) and must be read with this context:**
API-based verification (`exchange_api.get_order_from_exchange`) only exists for **Bybit and MEXC** — for every
other exchange (HTX/Gate/BingX/Telegram/...) `is_verified=False` is the *expected* state, not a bypass. Also, the
hard barrier itself ("receipt is never sent on unverified data") was only added to `orders/tasks.py` on
**2026-07-13** (`git log -S"НИКОГДА не бьётся" -- orders/tasks.py`); the `is_verified` column was added on
**2026-04-12** with no backfill migration (`orders/migrations/0020_order_is_verified.py` — plain
`AddField(default=False)`). Given the dataset starts at `SYSTEM_START = 2026-02-01`, a large share of any raw
count here is legacy data from before the column/barrier existed, not an active exploit of today's code. Split the
finding into three before treating it as critical:

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from datetime import datetime
from zoneinfo import ZoneInfo
from collections import defaultdict
from orders.models import Order

MSK = ZoneInfo('Europe/Moscow')
FIX_DATE = datetime(2026, 7, 13, tzinfo=MSK)  # when the hard barrier landed in tasks.py

def has_api_verification(exchange_type):
    ex = (exchange_type or '').lower()
    return ('bybit' in ex) or ('mexc' in ex)

qs = (Order.objects
      .exclude(receipt__uuid__isnull=True).exclude(receipt={})
      .filter(is_verified=False, is_manual=False))

no_api, bypass, bypass_recent = defaultdict(int), defaultdict(int), defaultdict(int)
no_api_total = bypass_total = bypass_recent_total = 0

for o in qs.iterator():
    if not has_api_verification(o.exchange_type):
        no_api[o.exchange_type] += 1
        no_api_total += 1
        continue
    bypass[o.exchange_type] += 1
    bypass_total += 1
    ts = (o.receipt or {}).get('timestamp')
    try:
        sent_at = datetime.strptime(ts, '%d.%m.%Y %H:%M:%S').replace(tzinfo=MSK) if ts else None
    except Exception:
        sent_at = None
    if sent_at and sent_at >= FIX_DATE:
        bypass_recent[o.exchange_type] += 1
        bypass_recent_total += 1

print('7A. No API verification exists for this exchange (architectural, not a bug):', no_api_total)
for k, v in sorted(no_api.items(), key=lambda x: -x[1]): print(' ', k, v)
print('7B. API verification EXISTS (Bybit/MEXC) but receipt sent without it — real bypass:', bypass_total)
for k, v in sorted(bypass.items(), key=lambda x: -x[1]): print(' ', k, v)
print('7C. ...of 7B, sent AFTER the 2026-07-13 fix (live/current bypass, not historical):', bypass_recent_total)
for k, v in sorted(bypass_recent.items(), key=lambda x: -x[1]): print(' ', k, v)
"
```

**How to read the three numbers:**
- **7A is not a finding to act on.** It's the expected state for exchanges that have no verification API at all —
  treat it as a separate, lower-priority question ("how, if at all, are these receipts corroborated?"), not as a
  bypass of anything.
- **7B is the real "bypass of an existing protection" number** — Bybit/MEXC support API verification and it still
  didn't happen. On the 2026-07-25 run this was non-zero but small relative to 7A; **investigate every row here.**
- **7C is the priority-one subset of 7B** — receipts sent *after* the 2026-07-13 fix landed. A non-zero 7C means
  the current code, right now, is still capable of fiscalizing unverified Bybit/MEXC data — that's an active defect
  to root-cause (not just historical debt), and every row should be traced through `api_views.order` /
  `tasks.verify_and_receipt_later` to find the exact path that let it through.

---

## 8. Timezone configuration sanity (created_at bucket-shift risk)

`bybit_api.py`, `mexc_api.py`, `bybit_service.py` and `mexc_service.py` all convert exchange millisecond
timestamps the same way: `datetime.fromtimestamp(ms/1000.0)` (naive, interpreted in the **OS's** local timezone)
followed by `django.utils.timezone.make_aware(dt)` (which just labels that naive value with Django's active
timezone, `settings.TIME_ZONE = 'Europe/Moscow'`, without converting it). This is only correct if the server's OS
timezone is *also* `Europe/Moscow`. If the server runs UTC (very common for Linux hosting), every synced
`created_at` is off by the MSK offset (currently 3h) — enough to push orders made in the first/last hours of a
month into the wrong month, and therefore the wrong quarter for `уведомление`/НДС periods.

```bash
# On the shell (not Python) — what timezone does the OS think it's in?
timedatectl 2>/dev/null | grep -i "time zone" || cat /etc/timezone 2>/dev/null || date +%Z
```

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from django.conf import settings
import time
print('DJANGO TIME_ZONE =', settings.TIME_ZONE, ' USE_TZ =', settings.USE_TZ)
print('OS local tzname   =', time.tzname)
"
```

**Norm:** OS timezone output should be `Europe/Moscow` (or `MSK`). **Signal:** anything else (`UTC`, `Etc/UTC`,
blank) confirms every historical `created_at` synced via the four files above is shifted and needs recomputation
from the raw exchange timestamps before it can be trusted for period boundaries.

---

## 9. Spot-check: orders sitting in the risky window at month start/end

Run this regardless of what #8 finds, to see how many orders are actually exposed to a potential shift (worth
manually cross-checking their timestamp against the exchange's own order page).

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from zoneinfo import ZoneInfo
from orders.models import Order

MSK = ZoneInfo('Europe/Moscow')
risky = []
for o in Order.objects.all().only('id', 'user_id', 'created_at', 'exchange_type', 'cost'):
    d = o.created_at.astimezone(MSK)
    if (d.day == 1 and d.hour < 4) or (d.day >= 28 and d.hour >= 20):
        risky.append((o.id, o.user_id, o.exchange_type, d.isoformat(), float(o.cost)))
print('ORDERS NEAR A MONTH BOUNDARY (+/- ~4h):', len(risky))
for row in risky[:40]:
    print(row)
"
```

**Norm:** informational — not itself a bug. **Signal to act on:** if #8 showed a TZ mismatch, every row printed
here is a candidate for having been reported in the wrong month/quarter; pick a handful and compare `d.isoformat()`
against the order's timestamp as shown on Bybit/MEXC's own order-history page.

---

## 10. Live parallel-fetch (admin "24h" view) vs persisted `Order` table — do they agree?

`admin_statistics_24h` reads live from `bybit_service.get_orders_parallel` / `mexc_service.get_mexc_orders_parallel`
(direct API calls, nothing persisted). Every other report reads from the `Order` table (persisted via
`bybit_api.sync_bybit_orders` / `mexc_api.sync_mexc_orders` on a schedule, or the extension's `POST /api/order`).
These are two independent pipelines with independent parsing/filtering logic — they are not guaranteed to agree.

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from django.db.models import Sum
from django.utils import timezone
from datetime import timedelta
from orders.models import Order, User
from orders.bybit_service import get_orders_parallel

since = timezone.now() - timedelta(hours=24)
users = User.objects.exclude(bybit_api_key__isnull=True).exclude(bybit_api_key='')
live = get_orders_parallel(users)
live_sum = sum(float(x.cost) for x in live)

db_qs = Order.objects.filter(exchange_type='Bybit', created_at__gte=since)
db_sum = float(db_qs.aggregate(s=Sum('cost'))['s'] or 0)

print('LIVE  count=%d sum=%.2f' % (len(live), live_sum))
print('DB    count=%d sum=%.2f' % (db_qs.count(), db_sum))
print('DIFF  count=%d sum=%.2f' % (len(live) - db_qs.count(), live_sum - db_sum))
"
```

**Norm:** small diff (a few orders) explained by ones still mid-settlement or synced in the last few minutes.
**Signal:** a persistently large gap means either the periodic sync task is failing silently for some users (check
`bybit_key_valid`/celery logs) or the two parsers disagree on what counts as a valid completed order — either way,
whichever number an admin trusts for "today's turnover" may not match what eventually lands in the monthly report.

---

## 11. `MonthlyManualEntry` vs real `Order` data for the same month (two sources of truth)

`_calc_month_profit_from_orders` only falls back to a manual entry when the combined USDT+TON order activity for
the month is zero. If orders for that user/month appear *after* a manual entry was already created (e.g. late
sync, backfilled data), the manual number silently stops being used and the calculated one takes over — with no
warning that the previously reported number (which may already have been submitted to ФНС) has changed.

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from orders.models import MonthlyManualEntry, Order

conflicts = []
for m in MonthlyManualEntry.objects.all():
    year, month = (int(x) for x in m.month.split('-'))
    exists = Order.objects.filter(user_id=m.user_id, created_at__year=year, created_at__month=month).exists()
    if exists:
        conflicts.append((m.user_id, m.month, m.source, float(m.gross)))
print('MANUAL-ENTRY / ORDER-DATA CONFLICTS:', len(conflicts))
for row in conflicts:
    print(row)
"
```

**Norm:** 0. **Signal:** any row is a month where the system will now report a *different* gross than the manual
figure that may already have been used for a filed `уведомление`/НДС — needs a human decision on which number is
correct, not an automatic recompute.

---

## 12. `DocumentSubmission` tracking — is it actually being recorded for anyone but one hardcoded user?

`toggle_document_submission` (`orders/views.py:1194`) is gated by
`@user_passes_test(lambda u: u.username == 'maks', login_url='my_orders')` — hardcoded to a single username rather
than "the logged-in user marking their own submission". Every other user hitting this endpoint gets silently
redirected instead of getting their checkbox saved.

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from orders.models import DocumentSubmission, User

for u in User.objects.exclude(username='maks'):
    cnt = DocumentSubmission.objects.filter(user=u, submitted=True).count()
    print(u.username, 'submitted_marks=', cnt)
"
```

**Norm (given the current code):** every non-`maks` user shows `0`, confirming the tracking has never worked for
them — treat that as the expected symptom of the bug in point 2's findings, not as "these users forgot to submit
anything." **If some non-`maks` users show a nonzero count,** the gate must have been different in the past — note
which users/periods so the FNS-deadline dashboard (`my_fns_documents`/`admin_fns_documents`) can be manually
reconciled for the affected accounts.

---

## Notes on what these checks *cannot* verify remotely

- **Duplicate Evotor receipts.** `Order.receipt` only ever stores the *last* `uuid` written — if the same order
  was fiscalized twice (see the race condition in finding 1 of the code review: `create_or_update_and_send_receipt`
  runs outside any DB lock, and `build_receipt_payload_v5` mints a fresh random `external_id` on every call, so
  Evotor itself has no idempotency key to dedupe on), the DB will not show it. This has to be checked directly in
  the Evotor/OFD personal cabinet by searching for receipts whose `external_id` starts with `ord_<order_id>_` and
  confirming exactly one exists per real trade.
- **Whether a given `Order.price/amount/cost` matches what the exchange says *right now*.** Check #6 only catches
  drift for orders that already have a receipt. For everything else, the only way to confirm current DB values
  still match the exchange is to re-run `exchange_api.get_order_from_exchange()` for a sample and diff it —
  cheap for a handful of orders, expensive (rate limits) for the whole table:

```bash
cd /opt/p2p_sys && venv/bin/python manage.py shell -c "
from orders.models import Order
from orders.exchange_api import get_order_from_exchange

sample = Order.objects.filter(exchange_type='Bybit', is_verified=True).order_by('-id')[:5]
for o in sample:
    fresh = get_order_from_exchange(user=o.user, order_id=o.external_id, exchange_name=o.exchange_type)
    print(o.id, o.external_id, 'stored=', float(o.price), float(o.cost), float(o.amount),
          'fresh=', fresh)
"
```
