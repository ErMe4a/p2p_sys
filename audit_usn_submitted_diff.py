# audit_all_tax_diff.py
# READ-ONLY. Сравнивает СТАРЫЙ (наивный, calc_tax_base) и НОВЫЙ (системный)
# расчёт налога для ВСЕХ пользователей (ОСНО и УСН обоих видов) и ВСЕХ
# уже наступивших сроков подачи (Q1/H1/M9 2026), НЕЗАВИСИМО от того,
# отмечен ли чекбокс "Отправлено". Ничего не меняет в БД.
#
# Для ОСНО:  старое = calc_tax_base (наивно, без manual-приоритета)
#            новое  = calc_system_ytd_base (как вкладка Прибыль)
# Для УСН:   старое = calc_tax_base
#            новое  = calc_system_usn_base
#
# Запуск:  python manage.py shell < audit_all_tax_diff.py

from decimal import Decimal
from django.utils import timezone

from orders.models import User, DocumentSubmission
from orders.uvedomlenie_generator import (
    calc_tax_base, calc_system_ytd_base, calc_system_usn_base,
    calc_osno, calc_usn_income, calc_usn_income_outcome,
    PERIODS,
)

YEAR = 2026
today = timezone.now()

print("=" * 100)
print(f"ПОЛНАЯ СВЕРКА НАЛОГА (ОСНО + УСН): СТАРЫЙ vs НОВЫЙ РАСЧЁТ, ВСЕ ЮЗЕРЫ, {YEAR}")
print("=" * 100)

all_users = User.objects.filter(tax_type__in=["OSNO", "OCH", "USN_INCOME", "USN_INCOME_OUTCOME"])
print(f"Пользователей ОСНО/УСН всего: {all_users.count()}\n")

submitted_map = {
    (s.user_id, s.period_key, s.year): s
    for s in DocumentSubmission.objects.filter(doc_type="uvedomlenie", year=YEAR)
}

results = []

for user in all_users:
    tax_type = (user.tax_type or "").upper()

    for period_key, period in PERIODS.items():
        last_month = period["last_month"]
        if today.month <= last_month:
            continue  # период ещё не завершился

        prev_month = {3: 0, 6: 3, 9: 6}[last_month]

        if tax_type in ("OSNO", "OCH"):
            old_profit = calc_tax_base(user.id, YEAR, last_month)["profit"]
            old_profit_prev = (calc_tax_base(user.id, YEAR, prev_month)["profit"]
                                if prev_month else Decimal(0))
            new_profit = calc_system_ytd_base(user, YEAR, last_month)
            new_profit_prev = calc_system_ytd_base(user, YEAR, prev_month)

            old_blocks = calc_osno(old_profit, old_profit_prev)
            new_blocks = calc_osno(new_profit, new_profit_prev)

        elif tax_type in ("USN_INCOME", "USN_INCOME_OUTCOME"):
            old_cum = calc_tax_base(user.id, YEAR, last_month)
            old_prev = (calc_tax_base(user.id, YEAR, prev_month) if prev_month
                        else {"income": Decimal(0), "expenses": Decimal(0), "profit": Decimal(0)})
            new_cum = calc_system_usn_base(user, YEAR, last_month)
            new_prev = calc_system_usn_base(user, YEAR, prev_month)

            if tax_type == "USN_INCOME":
                old_blocks = calc_usn_income(old_cum, old_prev)
                new_blocks = calc_usn_income(new_cum, new_prev)
            else:
                old_blocks = calc_usn_income_outcome(old_cum, old_prev)
                new_blocks = calc_usn_income_outcome(new_cum, new_prev)
        else:
            continue

        old_amount = sum(a for _, a in old_blocks)
        new_amount = sum(a for _, a in new_blocks)
        diff = new_amount - old_amount

        if abs(diff) <= 1:
            continue

        sub = submitted_map.get((user.id, period_key, YEAR))
        is_submitted = bool(sub and sub.submitted)

        results.append({
            "user": user.username,
            "tax_type": tax_type,
            "period": period["label"],
            "old_amount": old_amount,
            "new_amount": new_amount,
            "diff": diff,
            "submitted": is_submitted,
        })

print(f"Всего найдено расхождений (по всем юзерам/периодам): {len(results)}\n")

if not results:
    print("Расхождений не найдено вообще ни у кого - ОСНО и УСН считаются одинаково старым и новым методом.")
else:
    confirmed_submitted = [r for r in results if r["submitted"]]
    not_submitted = [r for r in results if not r["submitted"]]

    print("=" * 100)
    print(f"УЖЕ ОТМЕЧЕНО 'ОТПРАВЛЕНО' С НЕВЕРНОЙ СУММОЙ ({len(confirmed_submitted)}) - "
          "требует проверки, возможно уже подано в ФНС:")
    print("-" * 100)
    for a in sorted(confirmed_submitted, key=lambda x: -abs(x["diff"])):
        sign = "занижено" if a["diff"] > 0 else "завышено"
        print(f"  {a['user']:20s} | {a['tax_type']:20s} | {a['period']:15s} | "
              f"было: {a['old_amount']:>10.0f} руб | должно быть: {a['new_amount']:>10.0f} руб | "
              f"{sign} на {abs(a['diff']):>10.0f} руб")

    print()
    print("=" * 100)
    print(f"РАСХОЖДЕНИЕ ЕСТЬ, НО ЧЕКБОКС НЕ ОТМЕЧЕН ({len(not_submitted)}) - "
          "скорее всего ещё не подавали, но пересчитать/проверить стоит:")
    print("-" * 100)
    for a in sorted(not_submitted, key=lambda x: -abs(x["diff"])):
        sign = "занижено" if a["diff"] > 0 else "завышено"
        print(f"  {a['user']:20s} | {a['tax_type']:20s} | {a['period']:15s} | "
              f"старый расчёт: {a['old_amount']:>10.0f} руб | правильно: {a['new_amount']:>10.0f} руб | "
              f"{sign} на {abs(a['diff']):>10.0f} руб")

print("\n" + "=" * 100)
print("Диагностика завершена. БД не изменялась.")
print("=" * 100)