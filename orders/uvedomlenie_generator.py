# orders/uvedomlenie_generator.py
"""
Генерация XML-уведомления об исчисленных суммах налогов (КНД 1110355)
в формате ФНС 5.03 (как у "Астрал Отчет"), кодировка windows-1251.

Поддерживаемые режимы (user.tax_type):
  - USN_INCOME          → УСН "доходы" 6%
  - USN_INCOME_OUTCOME  → УСН "доходы минус расходы" 15%
  - OSNO / OCH          → НДФЛ ИП, прогрессивная шкала (13/15/18/20/22%),
                          суммы разбиваются на блоки по КБК каждой ступени.

Сумма считается автоматически из ордеров:
  доход  = Σ cost по SELL за период (с начала года по конец отчетного периода)
  расход = себестоимость реализованной ЦВ ("уравненный" метод, как в Excel-отчете)
           + комиссии BUY + комиссии SELL
  Аванс к уплате за период = налог нарастающим итогом − авансы предыдущих периодов.
"""

import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, date
from decimal import Decimal, ROUND_HALF_UP

from .models import Order

# ============================================================
# СПРАВОЧНИКИ
# ============================================================

# КБК УСН (актуальны на 2026)
KBK_USN_INCOME = "18210501011011000110"          # УСН "доходы"
KBK_USN_INCOME_OUTCOME = "18210501021011000110"  # УСН "доходы минус расходы"

# Прогрессивная шкала НДФЛ ИП НА ОСН "ЗА СЕБЯ" (ст. 227 НК):
# у ИП собственная серия КБК 020/021/022/023/024 (не путать с агентской).
# (порог налоговой базы нарастающим итогом, ставка, КБК)
#  - до 2,4 млн (налог до 312 тыс.)        13% -> ...02020...
#  - 2,4-5 млн  (налог 312-702 тыс.)       15% -> ...02021...
#  - 5-20 млн   (налог 702 тыс.-3,402 млн) 18% -> ...02022...
#  - 20-50 млн  (налог 3,402-9,402 млн)    20% -> ...02023...
#  - свыше 50 млн                          22% -> ...02024...
NDFL_BRACKETS = [
    (Decimal("2400000"),   Decimal("0.13"), "18210102020011000110"),
    (Decimal("5000000"),   Decimal("0.15"), "18210102021011000110"),
    (Decimal("20000000"),  Decimal("0.18"), "18210102022011000110"),
    (Decimal("50000000"),  Decimal("0.20"), "18210102023011000110"),
    (None,                 Decimal("0.22"), "18210102024011000110"),
]

# Ставки УСН
USN_INCOME_RATE = Decimal("0.06")
USN_INCOME_OUTCOME_RATE = Decimal("0.15")

# Отчетные периоды: ключ → (последний месяц периода, код для УСН, код для НДФЛ ИП)
# УСН авансы: 34/01 (1 кв), 34/02 (полугодие), 34/03 (9 мес). За год — декларация, уведомление не подается.
# НДФЛ ИП авансы: по образцу принятого файла — 31/02 за полугодие (коды 21/31/33 + номер).
#   ⚠ Если налоговая попросит уточнить коды НДФЛ — правится только этот словарь.
# НДФЛ ИП (авансы ст. 227): коды 21/04, 31/04, 33/04
# (приказ ФНС ЕД-7-8/20@, подтверждено разъяснениями ФНС 2026 г.)
PERIODS = {
    "Q1": {"last_month": 3, "usn": ("34", "01"), "ndfl": ("21", "04"), "label": "1 квартал"},
    "H1": {"last_month": 6, "usn": ("34", "02"), "ndfl": ("31", "04"), "label": "Полугодие"},
    "M9": {"last_month": 9, "usn": ("34", "03"), "ndfl": ("33", "04"), "label": "9 месяцев"},
}

VERS_PROG = "P2P System 1.0"
VERS_FORM = "5.03"


# ============================================================
# РАСЧЕТ НАЛОГОВОЙ БАЗЫ
# ============================================================

def _order_commission(o):
    """Комиссия ордера в рублях (та же логика, что в export_excel_report)."""
    comm_val = Decimal(str(o.commission or 0))
    if o.commission_type == "PERCENT":
        return Decimal(str(o.cost or 0)) * comm_val / 100
    return comm_val


def calc_tax_base(user_id, year, last_month):
    """
    Считает нарастающим итогом с 1 января по конец last_month:
      income   — Σ cost по SELL
      expenses — себестоимость реализованной ЦВ + все комиссии
    Себестоимость: из общей стоимости покупок вычитается стоимость
    нереализованного остатка (остаток закрывается последними покупками —
    как в "уравненном результате" Excel-отчета).
    """
    orders = Order.objects.filter(
        user_id=user_id,
        created_at__date__gte=date(year, 1, 1),
        created_at__date__lte=_last_day(year, last_month),
    ).order_by("created_at")

    t_buy_qty = Decimal(0); t_buy_cost = Decimal(0); t_buy_comm = Decimal(0)
    t_sell_qty = Decimal(0); t_sell_cost = Decimal(0); t_sell_comm = Decimal(0)
    t_sell_exch_comm = Decimal(0)
    buys_list = []

    for o in orders:
        qty = Decimal(str(o.amount or 0))
        cost = Decimal(str(o.cost or 0))
        comm = _order_commission(o)

        if o.operation_type == "BUY":
            t_buy_qty += qty
            t_buy_cost += cost
            t_buy_comm += comm
            buys_list.append({"qty": qty, "cost": cost})
        else:  # SELL
            hist_percent = Decimal(str(o.exchange_commission_rate or 0))
            t_sell_qty += qty
            t_sell_cost += cost
            t_sell_comm += comm
            t_sell_exch_comm += qty * hist_percent / 100

    # Остаток нереализованной ЦВ и его себестоимость (закрываем последними BUY)
    remainder_qty = t_buy_qty - t_sell_qty - t_sell_exch_comm
    remainder_cost = Decimal(0)
    temp_qty = remainder_qty
    for buy in reversed(buys_list):
        if temp_qty <= 0:
            break
        if buy["qty"] >= temp_qty:
            unit = buy["cost"] / buy["qty"] if buy["qty"] else Decimal(0)
            remainder_cost += temp_qty * unit
            temp_qty = Decimal(0)
        else:
            remainder_cost += buy["cost"]
            temp_qty -= buy["qty"]

    equalized_buy_cost = t_buy_cost - remainder_cost
    income = t_sell_cost
    expenses = equalized_buy_cost + t_buy_comm + t_sell_comm

    return {"income": income, "expenses": expenses, "profit": income - expenses}


def _last_day(year, month):
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - __import__("datetime").timedelta(days=1)


def calc_system_ytd_base(user, year, last_month):
    """
    Налоговая база "как на вкладке Прибыль": сумма по месяцам 1..last_month
    значений max(0, gross_месяца - расходы_месяца), где:
      - gross считается ТЕМИ ЖЕ функциями, что и вкладка Прибыль
        (_calc_month_profit_filtered: помесячный LIFO с переносом остатка,
         USDT+TON, комиссия биржи в рублях);
      - если в месяце нет ордеров - gross берется из MonthlyManualEntry
        (данные, загруженные из Excel);
      - расходы месяца (Банк/Биржа/Прочие) - из UserExpense.
    Возвращает Decimal. last_month=0 -> Decimal(0).
    """
    if not last_month:
        return Decimal(0)

    # Ленивые импорты - чтобы не создать циклический импорт views <-> generator
    from zoneinfo import ZoneInfo
    from django.db.models import Sum
    from .views import _calc_month_profit_filtered
    from .models import MonthlyManualEntry, UserExpense

    MSK = ZoneInfo("Europe/Moscow")
    total = Decimal(0)

    for mo in range(1, last_month + 1):
        ms_start = datetime(year, mo, 1, tzinfo=MSK)
        ms_end = (datetime(year, mo + 1, 1, tzinfo=MSK)
                  if mo < 12 else datetime(year + 1, 1, 1, tzinfo=MSK))
        mo_key = f"{year}-{str(mo).zfill(2)}"

        calc = _calc_month_profit_filtered(user, ms_start, ms_end)
        gross_mo = calc["gross"]

        # Ручная запись месяца (Excel) ПРИОРИТЕТНЕЕ ордеров:
        # так же отображает месяц вкладка "Прибыль". Если manual есть -
        # берем его gross, даже когда в месяце случайно есть ордера
        # (например, частично засинкались поверх ручных данных).
        manual = MonthlyManualEntry.objects.filter(user=user, month=mo_key).first()
        if manual is not None:
            gross_mo = float(manual.gross)

        expenses_mo = float(
            UserExpense.objects.filter(user=user, month=mo_key)
            .aggregate(Sum("amount"))["amount__sum"] or 0
        )

        # База месяца не бывает отрицательной - ровно как на вкладке Прибыль
        total += Decimal(str(max(0.0, gross_mo - expenses_mo)))

    return total


# ============================================================
# РАСЧЕТ НАЛОГА ПО РЕЖИМАМ
# ============================================================

def _r(x):
    """Округление до рубля (в уведомлении суммы в рублях)."""
    return int(Decimal(x).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def calc_usn_income(base_cum, base_prev):
    """УСН доходы 6%. Возвращает [(КБК, сумма к уплате за период)]."""
    tax_cum = max(base_cum["income"], Decimal(0)) * USN_INCOME_RATE
    tax_prev = max(base_prev["income"], Decimal(0)) * USN_INCOME_RATE
    delta = _r(tax_cum) - _r(tax_prev)
    return [(KBK_USN_INCOME, delta)] if delta > 0 else []


def calc_usn_income_outcome(base_cum, base_prev):
    """УСН доходы-расходы 15%."""
    tax_cum = max(base_cum["profit"], Decimal(0)) * USN_INCOME_OUTCOME_RATE
    tax_prev = max(base_prev["profit"], Decimal(0)) * USN_INCOME_OUTCOME_RATE
    delta = _r(tax_cum) - _r(tax_prev)
    return [(KBK_USN_INCOME_OUTCOME, delta)] if delta > 0 else []


def _ndfl_by_brackets(profit):
    """Налог по прогрессивной шкале, разбивка по КБК: {КБК: сумма}."""
    result = {}
    prev_cap = Decimal(0)
    for cap, rate, kbk in NDFL_BRACKETS:
        if profit <= prev_cap:
            break
        upper = profit if cap is None else min(profit, cap)
        part = (upper - prev_cap) * rate
        if part > 0:
            result[kbk] = result.get(kbk, Decimal(0)) + part
        if cap is None or profit <= cap:
            break
        prev_cap = cap
    return result


def calc_osno(base_cum_val, base_prev_val):
    """
    НДФЛ ИП: дельта по каждой ступени/КБК отдельно.
    base_cum_val / base_prev_val - налоговые базы (Decimal),
    посчитанные "как на вкладке Прибыль" (calc_system_ytd_base).
    """
    cum = _ndfl_by_brackets(max(base_cum_val, Decimal(0)))
    prev = _ndfl_by_brackets(max(base_prev_val, Decimal(0)))
    blocks = []
    for kbk in [b[2] for b in NDFL_BRACKETS]:
        delta = _r(cum.get(kbk, 0)) - _r(prev.get(kbk, 0))
        if delta > 0:
            blocks.append((kbk, delta))
    return blocks


# ============================================================
# СБОРКА XML
# ============================================================

def build_uvedomlenie(user, year, period_key):
    """
    Главная функция. Возвращает (filename, xml_bytes, info_dict).
    Требуемые поля пользователя: inn, tax_type, oktmo, kod_no,
    ФИО: last_name_ndfl/first_name_ndfl/middle_name_ndfl (или last_name/first_name).
    """
    period = PERIODS[period_key]
    last_month = period["last_month"]
    prev_month = {3: 0, 6: 3, 9: 6}[last_month]

    tax_type = (user.tax_type or "").upper()

    if tax_type in ("OSNO", "OCH"):
        # НДФЛ ИП: база СТРОГО как на вкладке Прибыль
        # (LIFO по месяцам, ручные месяцы из Excel, минус расходы).
        base_cum_val = calc_system_ytd_base(user, year, last_month)
        base_prev_val = calc_system_ytd_base(user, year, prev_month)
        blocks = calc_osno(base_cum_val, base_prev_val)
        p_code, p_num = period["ndfl"]
        info_income = info_expenses = None
        info_profit = base_cum_val
    elif tax_type in ("USN_INCOME", "USN_INCOME_OUTCOME"):
        base_cum = calc_tax_base(user.id, year, last_month)
        base_prev = (calc_tax_base(user.id, year, prev_month)
                     if prev_month else {"income": Decimal(0), "expenses": Decimal(0), "profit": Decimal(0)})
        if tax_type == "USN_INCOME":
            blocks = calc_usn_income(base_cum, base_prev)
        else:
            blocks = calc_usn_income_outcome(base_cum, base_prev)
        p_code, p_num = period["usn"]
        info_income = base_cum["income"]; info_expenses = base_cum["expenses"]
        info_profit = base_cum["profit"]
    else:
        raise ValueError(f"Для режима {tax_type} уведомление не формируется (например, ПАТЕНТ).")

    if not blocks:
        raise ValueError("Сумма аванса к уплате за период равна нулю — уведомление не требуется.")

    # --- Реквизиты ---
    inn = (user.inn or "").strip()
    if len(inn) != 12 or not inn.isdigit():
        raise ValueError("ИНН должен состоять из 12 цифр (заполните в настройках).")
    oktmo = (getattr(user, "oktmo", "") or "").strip()
    if len(oktmo) not in (8, 11) or not oktmo.isdigit():
        raise ValueError("ОКТМО должен состоять из 8 или 11 цифр (заполните в настройках).")
    kod_no = (getattr(user, "kod_no", "") or "").strip()
    if len(kod_no) != 4 or not kod_no.isdigit():
        raise ValueError("Код налогового органа должен состоять из 4 цифр (заполните в настройках).")

    # ФИО приводим к ВЕРХНЕМУ регистру (как в печатной форме ФНС),
    # независимо от того, как записано в настройках пользователя.
    fam = (getattr(user, "last_name_ndfl", "") or user.last_name or "").strip().upper()
    name = (getattr(user, "first_name_ndfl", "") or user.first_name or "").strip().upper()
    otch = (getattr(user, "middle_name_ndfl", "") or getattr(user, "middle_name", "") or "").strip().upper()
    if not fam or not name:
        raise ValueError("Не заполнены фамилия/имя подписанта (настройки пользователя).")

    # --- Имя файла и ИдФайл (должны совпадать) ---
    today = datetime.now()
    guid = str(uuid.uuid4()).upper()
    file_id = f"UT_UVISCHSUMNAL_{kod_no}_{kod_no}_{inn}_{today.strftime('%Y%m%d')}_{guid}"
    filename = f"{file_id}.xml"

    # --- XML ---
    root = ET.Element("Файл", {
        "ИдФайл": file_id,
        "ВерсПрог": VERS_PROG,
        "ВерсФорм": VERS_FORM,
    })
    doc = ET.SubElement(root, "Документ", {
        "КНД": "1110355",
        "ДатаДок": today.strftime("%d.%m.%Y"),
        "КодНО": kod_no,
    })
    svnp = ET.SubElement(doc, "СвНП")
    ET.SubElement(svnp, "НПИП", {"ИННФЛ": inn})
    signer = ET.SubElement(doc, "Подписант", {"ПрПодп": "1"})
    fio_attrs = {"Фамилия": fam, "Имя": name}
    if otch:
        fio_attrs["Отчество"] = otch
    ET.SubElement(signer, "ФИО", fio_attrs)

    for kbk, amount in blocks:
        ET.SubElement(doc, "УвИсчСумНалог", {
            "ОКТМО": oktmo,
            "КБК": kbk,
            "СумНалогАванс": str(amount),
            "Период": p_code,
            "НомерМесКварт": p_num,
            "Год": str(year),
        })

    ET.indent(root, space="  ")
    # Декларацию пишем вручную с ДВОЙНЫМИ кавычками (как у Астрала):
    # ElementTree ставит одинарные, а валидаторы ФНС-форматов
    # распознают файл по точному виду заголовка.
    body = ET.tostring(root, encoding="windows-1251", xml_declaration=False)
    xml_bytes = '<?xml version="1.0" encoding="windows-1251"?>\n'.encode("ascii") + body

    info = {
        "income": float(info_income) if info_income is not None else None,
        "expenses": float(info_expenses) if info_expenses is not None else None,
        "profit": float(info_profit),
        "blocks": [(k, a) for k, a in blocks],
        "period": f"{p_code}/{p_num}",
        "label": period["label"],
    }
    return filename, xml_bytes, info