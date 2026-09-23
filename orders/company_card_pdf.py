"""
Генерация PDF "Карточка предприятия" — реквизиты ИП/самозанятого трейдера
для скачивания из админки (кнопка в модалке "Отчёты" на /p2p-admin/users/).
Формат/состав полей — по образцу карточки, предоставленному Максимом.

Данные берутся из тех же полей User/UserBankAccount, что заполняются
трейдером в /settings/ (см. orders/models.py, orders/templates/orders/settings.html).
"""
import os
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

FONTS_DIR = os.path.join(os.path.dirname(__file__), 'fonts')

_FONTS_REGISTERED = False


def _ensure_fonts():
    """Кириллический TTF-шрифт (DejaVu Sans) — встроенные шрифты reportlab кириллицу не поддерживают."""
    global _FONTS_REGISTERED
    if _FONTS_REGISTERED:
        return
    pdfmetrics.registerFont(TTFont('DejaVuSans', os.path.join(FONTS_DIR, 'DejaVuSans.ttf')))
    pdfmetrics.registerFont(TTFont('DejaVuSans-Bold', os.path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf')))
    _FONTS_REGISTERED = True


TAX_TYPE_LABELS = {
    'OSNO': 'ОСНО',
    'OCH': 'ОСНО',
    'USN_INCOME': 'УСН доход (1%)',
    'USN_INCOME_OUTCOME': 'УСН доход-расход (15%)',
}


def _dash(value):
    value = (value or '').strip() if isinstance(value, str) else value
    return str(value) if value else '—'


def _full_name(user):
    parts = [user.last_name, user.first_name, user.middle_name]
    return ' '.join(p for p in parts if p) or user.username


def _short_name(user):
    last = user.last_name or user.username
    initials = ''.join(f'{p[0]}.' for p in (user.first_name, user.middle_name) if p)
    return f'{last} {initials}'.strip()


def _requisites_table(rows, styles):
    label_style, value_style = styles
    data = [[Paragraph(label, label_style), Paragraph(value, value_style)] for label, value in rows]
    t = Table(data, colWidths=[55 * mm, 105 * mm])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('LINEBELOW', (0, 0), (-1, -2), 0.4, colors.HexColor('#e0e0e0')),
    ]))
    return t


def build_company_card_pdf(user):
    """Возвращает (pdf_bytes, filename) для ответа HttpResponse."""
    _ensure_fonts()

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=18 * mm, bottomMargin=18 * mm, leftMargin=20 * mm, rightMargin=20 * mm,
    )

    title_style = ParagraphStyle(
        'Title', fontName='DejaVuSans-Bold', fontSize=16, alignment=TA_CENTER, spaceAfter=4,
    )
    subtitle_style = ParagraphStyle(
        'Subtitle', fontName='DejaVuSans', fontSize=12, alignment=TA_CENTER, spaceAfter=14,
        textColor=colors.HexColor('#333333'),
    )
    section_style = ParagraphStyle(
        'Section', fontName='DejaVuSans-Bold', fontSize=11, spaceBefore=14, spaceAfter=6,
        textColor=colors.HexColor('#1f3d7a'),
    )
    label_style = ParagraphStyle('Label', fontName='DejaVuSans', fontSize=9, textColor=colors.HexColor('#666666'))
    value_style = ParagraphStyle('Value', fontName='DejaVuSans', fontSize=10, textColor=colors.HexColor('#111111'))

    full_name = _full_name(user)
    short_name = _short_name(user)

    story = [
        Paragraph('КАРТОЧКА ПРЕДПРИЯТИЯ', title_style),
        Paragraph(f'ИП {full_name}', subtitle_style),

        Paragraph('Реквизиты предприятия', section_style),
        _requisites_table([
            ('Наименование', f'Индивидуальный предприниматель {full_name}'),
            ('Сокращенное наименование', f'ИП {short_name}'),
            ('ИНН', _dash(user.inn)),
            ('ОГРНИП', _dash(user.ogrnip)),
            ('Дата регистрации', user.ip_registration_date.strftime('%d.%m.%Y') if user.ip_registration_date else '—'),
            ('Форма налогообложения', TAX_TYPE_LABELS.get(user.tax_type, _dash(user.tax_type))),
        ], (label_style, value_style)),
    ]

    accounts = list(user.bank_accounts.all())
    story.append(Paragraph('Банковские реквизиты', section_style))
    if accounts:
        for i, acc in enumerate(accounts, start=1):
            if len(accounts) > 1:
                story.append(Paragraph(f'Счёт {i}', ParagraphStyle(
                    'AccN', fontName='DejaVuSans-Bold', fontSize=9.5, spaceBefore=6, spaceAfter=2,
                    textColor=colors.HexColor('#444444'),
                )))
            story.append(_requisites_table([
                ('Банк', _dash(acc.bank_name)),
                ('Расчетный счет', _dash(acc.account_number)),
                ('Корреспондентский счет', _dash(acc.corr_account)),
                ('БИК', _dash(acc.bik)),
            ], (label_style, value_style)))
    else:
        story.append(Paragraph('Банковские реквизиты не заполнены.', value_style))

    story.append(Paragraph('Контактная информация', section_style))
    story.append(_requisites_table([
        ('Юридический адрес', _dash(user.registration_address)),
        ('Телефон', _dash(user.phone)),
        ('Email', _dash(user.email)),
    ], (label_style, value_style)))

    doc.build(story)
    pdf_bytes = buf.getvalue()
    buf.close()

    safe_login = ''.join(c for c in user.username if c.isalnum() or c in ('_', '-')) or 'user'
    filename = f'Карточка_предприятия_{safe_login}.pdf'
    return pdf_bytes, filename
