# orders/nds_generator.py
"""
Генерация XML-декларации по НДС (КНД 1151001) в формате ФНС 5.12
(как у "Астрал Отчет"), кодировка windows-1251.

Контекст: ИП на ОСНО формально является плательщиком НДС и обязан
подавать декларацию КАЖДЫЙ КВАРТАЛ, даже если платить нечего.
Операции с цифровой валютой НЕ облагаются НДС (пп. в НК), поэтому
декларация всегда содержит:
  - СумПУ_173.1 = 0 (к уплате всегда 0)
  - Раздел 7 (необлагаемые операции): код 1010840 "реализация
    цифровой валюты" + сумма реализации ЗА КВАРТАЛ (не нарастающим
    итогом, в отличие от уведомления по НДФЛ/УСН!)

Формируется ТОЛЬКО для пользователей на ОСНО/ОСН (УСН и Патент НДС
не платят и декларацию не подают).

Сумма реализации считается автоматически: Σ cost всех SELL-ордеров
строго за выбранный квартал (используется тот же путь расчёта, что
и годовая страница Прибыли, - _calc_month_profit_from_orders /
manual-записи, чтобы сумма совпадала с системой).
"""

import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, date
from decimal import Decimal, ROUND_HALF_UP

from .models import Order

# ============================================================
# СПРАВОЧНИКИ
# ============================================================

KBK_NDS = "18210301000011000110"
KOD_OPER_CRYPTO = "1010840"  # реализация цифровой валюты (необлагаемая операция)

VERS_PROG = "P2P System 1.0"
VERS_FORM = "5.12"
PO_MESTU = "116"  # по месту жительства ИП (фиксированное значение для этого случая)

# Кварталы: ключ -> (первый месяц, последний месяц, код периода НДС)
# Внимание: коды периода НДС (21/22/23/24) - СВОЯ нумерация,
# отличается от кодов периода уведомления по НДФЛ/УСН.
QUARTERS = {
    "Q1": {"start_month": 1, "end_month": 3,  "code": "21", "label": "1 квартал"},
    "Q2": {"start_month": 4, "end_month": 6,  "code": "22", "label": "2 квартал"},
    "Q3": {"start_month": 7, "end_month": 9,  "code": "23", "label": "3 квартал"},
    "Q4": {"start_month": 10, "end_month": 12, "code": "24", "label": "4 квартал"},
}


def _last_day(year, month):
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - __import__("datetime").timedelta(days=1)


def _r(x):
    """Округление до рубля (математическое: 0.5 -> вверх)."""
    return int(Decimal(str(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# ============================================================
# РАСЧЕТ РЕАЛИЗАЦИИ ЗА КВАРТАЛ
# ============================================================

def calc_quarter_realization(user, year, start_month, end_month):
    """
    Сумма реализации цифровой валюты СТРОГО за квартал (не нарастающим
    итогом): сумма месячных Доходов (Sell) с учетом ручных записей
    из Excel - тем же путем, что и годовая страница Прибыли
    (_calc_month_profit_from_orders + приоритет manual при отсутствии
    активности по ордерам), чтобы сумма всегда совпадала с системой.
    Возвращает Decimal (рубли, с копейками - округляется на выходе).
    """
    from collections import defaultdict
    from zoneinfo import ZoneInfo
    from .views import (
        SYSTEM_START,
        _calc_month_profit_from_orders,
    )
    from .models import MonthlyManualEntry

    MSK = ZoneInfo("Europe/Moscow")
    year_end = datetime(year + 1, 1, 1, tzinfo=MSK)

    orders = list(
        Order.objects
        .filter(user=user, created_at__gte=SYSTEM_START, created_at__lt=year_end)
        .order_by("created_at")
    )
    all_orders_by_user = {user.id: orders}

    manuals_by_user_month = {}
    for m in MonthlyManualEntry.objects.filter(user=user, month__startswith=str(year)):
        manuals_by_user_month[(user.id, m.month)] = m

    total = Decimal(0)
    for mo in range(start_month, end_month + 1):
        ms_start = datetime(year, mo, 1, tzinfo=MSK)
        ms_end = (datetime(year + 1, 1, 1, tzinfo=MSK)
                  if mo == 12 else datetime(year, mo + 1, 1, tzinfo=MSK))
        mo_key = f"{year}-{str(mo).zfill(2)}"

        calc = _calc_month_profit_from_orders(user.id, ms_start, ms_end, all_orders_by_user)
        has_activity = calc["month_buy_qty"] > 0 or calc["month_sell_qty"] > 0

        if has_activity:
            sell_cost = calc["month_sell_cost"]
        else:
            manual = manuals_by_user_month.get((user.id, mo_key))
            sell_cost = float(manual.sell_cost) if manual else 0.0

        total += Decimal(str(sell_cost))

    return total


# ============================================================
# СБОРКА XML
# ============================================================

NDS_USN_THRESHOLD = Decimal("20000000")


def build_nds_declaration(user, year, quarter_key):
    """
    Главная функция. Возвращает (filename, xml_bytes, info_dict).
    Требуемые поля пользователя: inn, oktmo, kod_no, phone, ФИО
    (last_name/first_name/middle_name).

    Формируется для ОСНО/ОСН всегда, и для УСН (доходы / доходы-расходы) —
    только начиная с квартала, в котором накопительный с начала года
    оборот по продаже (sell) превышает 20 000 000 ₽ (аналог освобождения
    от НДС по ст.145 НК — пока оборот ниже порога, обязанности подавать
    декларацию нет вообще). Реализация цифровой валюты НДС не облагается
    НИКОГДА, ни у ОСНО, ни у УСН (пп. НК) — к уплате всегда 0, порог
    влияет только на то, нужно ли вообще подавать декларацию и с какой
    суммы вести отсчёт в разделе 7. Счётчик накопительного оборота
    ежегодно обнуляется с 1 января.
    """
    tax_type = (user.tax_type or "").upper()
    q = QUARTERS[quarter_key]

    if tax_type in ("OSNO", "OCH"):
        realization = calc_quarter_realization(user, year, q["start_month"], q["end_month"])
    elif tax_type in ("USN_INCOME", "USN_INCOME_OUTCOME"):
        # Сколько было накопительно ДО этого квартала и НА КОНЕЦ этого
        # квартала — чтобы понять, произошло ли пробитие порога именно
        # сейчас, было пробито раньше в этом же году, или ещё не пробито.
        cumulative_before = (
            calc_quarter_realization(user, year, 1, q["start_month"] - 1)
            if q["start_month"] > 1 else Decimal(0)
        )
        cumulative_end = calc_quarter_realization(user, year, 1, q["end_month"])

        if cumulative_end <= NDS_USN_THRESHOLD:
            raise ValueError(
                "Накопительный оборот по продаже с начала года не превышает порог "
                "20 000 000 ₽ — декларация по НДС не требуется."
            )
        if cumulative_before >= NDS_USN_THRESHOLD:
            # Порог уже был пробит в одном из прошлых кварталов этого года —
            # весь текущий квартал целиком идёт в раздел 7.
            realization = calc_quarter_realization(user, year, q["start_month"], q["end_month"])
        else:
            # Порог пробивается именно в этом квартале — в раздел 7 идёт
            # только часть оборота СВЕРХ 20 млн, а не весь квартал.
            realization = cumulative_end - NDS_USN_THRESHOLD
    else:
        raise ValueError(
            "Декларация по НДС формируется только для ОСНО и для УСН, "
            "превысившей порог оборота по продаже 20 000 000 ₽ "
            "(Патент НДС не платит)."
        )

    realization_r = _r(realization)

    # --- Реквизиты (те же проверки, что и в уведомлении) ---
    inn = (user.inn or "").strip()
    if len(inn) != 12 or not inn.isdigit():
        raise ValueError("ИНН должен состоять из 12 цифр (заполните в настройках).")
    oktmo = (getattr(user, "oktmo", "") or "").strip()
    if len(oktmo) not in (8, 11) or not oktmo.isdigit():
        raise ValueError("ОКТМО должен состоять из 8 или 11 цифр (заполните в настройках).")
    kod_no = (getattr(user, "kod_no", "") or "").strip()
    if len(kod_no) != 4 or not kod_no.isdigit():
        raise ValueError("Код налогового органа должен состоять из 4 цифр (заполните в настройках).")
    phone = (getattr(user, "phone", "") or "").strip()
    if not phone or not phone.isdigit():
        raise ValueError("Не заполнен телефон (11 цифр, например 79855601686) в настройках пользователя.")

    # ФИО в декларации НДС - НЕ капсом, обычным регистром (см. эталон)
    fam = (getattr(user, "last_name_ndfl", "") or user.last_name or "").strip()
    name = (getattr(user, "first_name_ndfl", "") or user.first_name or "").strip()
    otch = (getattr(user, "middle_name_ndfl", "") or getattr(user, "middle_name", "") or "").strip()
    if not fam or not name:
        raise ValueError("Не заполнены фамилия/имя подписанта (настройки пользователя).")

    # --- Имя файла и ИдФайл (должны совпадать) ---
    today = datetime.now()
    guid = str(uuid.uuid4()).upper()
    file_id = f"NO_NDS_{kod_no}_{kod_no}_{inn}_{today.strftime('%Y%m%d')}_{guid}"
    filename = f"{file_id}.xml"

    # --- XML ---
    root = ET.Element("Файл", {
        "ИдФайл": file_id,
        "ВерсПрог": VERS_PROG,
        "ВерсФорм": VERS_FORM,
        "ПризнНал8-12": "0",  # разделов 8-12 нет: облагаемых операций нет
    })
    doc = ET.SubElement(root, "Документ", {
        "КНД": "1151001",
        "ДатаДок": today.strftime("%d.%m.%Y"),
        "Период": q["code"],
        "ОтчетГод": str(year),
        "КодНО": kod_no,
        "НомКорр": "0",
        "ПоМесту": PO_MESTU,
    })
    svnp = ET.SubElement(doc, "СвНП", {"Тлф": phone})
    npfl = ET.SubElement(svnp, "НПФЛ", {"ИННФЛ": inn})
    fio_attrs = {"Фамилия": fam, "Имя": name}
    if otch:
        fio_attrs["Отчество"] = otch
    ET.SubElement(npfl, "ФИО", fio_attrs)

    ET.SubElement(doc, "Подписант", {"ПрПодп": "1"})

    nds = ET.SubElement(doc, "НДС")
    ET.SubElement(nds, "СумУплНП", {
        "ОКТМО": oktmo,
        "КБК": KBK_NDS,
        "СумПУ_173.1": "0",
        "ПризнСЗПК": "2",
    })
    oper_ne_nal = ET.SubElement(nds, "ОперНеНал")
    ET.SubElement(oper_ne_nal, "СумОпер7", {
        "КодОпер": KOD_OPER_CRYPTO,
        "СтРеалТов": str(realization_r),
    })

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="windows-1251", xml_declaration=False)
    xml_bytes = '<?xml version="1.0" encoding="windows-1251"?>\n'.encode("ascii") + body

    info = {
        "realization": float(realization),
        "realization_rounded": realization_r,
        "quarter": q["label"],
        "period_code": q["code"],
    }
    return filename, xml_bytes, info