# audit_usn_submitted_diff.py
# READ-ONLY. Сравнивает СТАРЫЙ (наивный, calc_tax_base) и НОВЫЙ (системный,
# calc_system_usn_base) расчёт УСН для всех уведомлений, которые
# ПОЛЬЗОВАТЕЛИ УЖЕ ОТМЕТИЛИ как "Отправлено" (DocumentSubmission).
# Ничего не меняет в БД, только читает и печатает.
#
# Запуск:  python manage.py shell < audit_usn_submitted_diff.py

from decimal import Decimal

from orders.models import User, DocumentSubmission
from orders.uvedomlenie_generator import (
    calc_tax_base, calc_system_usn_base,
    calc_usn_income, calc_usn_income_outcome,
    PERIODS,
)

print("=" * 90)
print("СРАВНЕНИЕ СТАРОГО И НОВОГО РАСЧЁТА УСН ПО УЖЕ ОТПРАВЛЕННЫМ УВЕДОМЛЕНИЯМ")
print("=" * 90)

submissions = (
    DocumentSubmission.objects
    .filter(doc_type="uvedomlenie", submitted=True)
    .select_related("user")
    .order_by("user__username", "year", "period_key")
)

print(f"Всего отмеченных 'Отправлено' уведомлений: {submissions.count()}\n")

affected = []
checked = 0

for sub in submissions:
    user = sub.user
    tax_type = (user.tax_type or "").upper()
    if tax_type not in ("USN_INCOME", "USN_INCOME_OUTCOME"):
        continue  # интересует только УСН, ОСНО не затронуто этим багом

    period_key = sub.period_key
    year = sub.year
    if period_key not in PERIODS:
        print(f"  ⚠ {user.username}: неизвестный period_key={period_key!r}, пропуск")
        continue

    period = PERIODS[period_key]
    last_month = period["last_month"]
    prev_month = {3: 0, 6: 3, 9: 6}[last_month]
    checked += 1

    # --- СТАРЫЙ расчёт (наивный, как было отправлено) ---
    old_cum = calc_tax_base(user.id, year, last_month)
    old_prev = (calc_tax_base(user.id, year, prev_month) if prev_month
                else {"income": Decimal(0), "expenses": Decimal(0), "profit": Decimal(0)})

    # --- НОВЫЙ расчёт (системный, правильный) ---
    new_cum = calc_system_usn_base(user, year, last_month)
    new_prev = calc_system_usn_base(user, year, prev_month)

    if tax_type == "USN_INCOME":
        old_blocks = calc_usn_income(old_cum, old_prev)
        new_blocks = calc_usn_income(new_cum, new_prev)
    else:
        old_blocks = calc_usn_income_outcome(old_cum, old_prev)
        new_blocks = calc_usn_income_outcome(new_cum, new_prev)

    old_amount = sum(a for _, a in old_blocks)
    new_amount = sum(a for _, a in new_blocks)
    diff = new_amount - old_amount

    if abs(diff) > 1:  # существенное расхождение (не просто копейка округления)
        affected.append({
            "user": user.username,
            "tax_type": tax_type,
            "period": f"{year} / {period['label']}",
            "old_amount": old_amount,
            "new_amount": new_amount,
            "diff": diff,
            "submitted_at": sub.submitted_at,
        })

print(f"Проверено уведомлений (УСН, отмеченных отправленными): {checked}")
print(f"Из них с расхождением старой/новой суммы: {len(affected)}\n")

if not affected:
    print("✅ Расхождений не найдено - все ранее отправленные УСН-уведомления совпадают со старым и новым расчётом.")
else:
    print("НАЙДЕНЫ РАСХОЖДЕНИЯ - ниже список, требующий проверки/корректировки:")
    print("-" * 90)
    for a in sorted(affected, key=lambda x: -abs(x["diff"])):
        sign = "занижено" if a["diff"] > 0 else "завышено"
        print(f"  {a['user']:20s} | {a['tax_type']:20s} | {a['period']:20s} | "
              f"было отправлено: {a['old_amount']:>10.0f} ₽ | должно быть: {a['new_amount']:>10.0f} ₽ | "
              f"{sign} на {abs(a['diff']):>10.0f} ₽ | отмечено отправленным: {a['submitted_at']}")

print("\n" + "=" * 90)
print("Диагностика завершена. БД не изменялась.")
print("=" * 90)