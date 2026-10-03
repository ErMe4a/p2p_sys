"""
Документооборот: формирование .docx-документов от имени трейдера по шаблонам
(раздел «Документооборот» в админке, см. openspec/changes/admin-document-workflow).

Шаблоны лежат в orders/doc_templates/. Это подготовленные копии файлов Максима:
жёлтые заглушки заменены токенами вида {{FIO}}, каждый токен целиком в одном
<w:r>, жёлтая заливка снята, остальной текст и вёрстка не тронуты. Если
Максим пришлёт новую редакцию шаблона, её готовят так же (токен целиком в
одном run, иначе Word разобьёт его и заполнение упадёт с явной ошибкой).

Генерация read-only: только читает профиль пользователя, ничего не пишет.
"""
import io
import os
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date
from typing import Callable
from xml.sax.saxutils import escape

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'doc_templates')

_TOKEN_RE = re.compile(r'\{\{[A-Z_]+\}\}')

# Ссылки на правила бирж (подставляются в форму по умолчанию, админ может
# поправить). Сопоставление по имени биржи без учёта регистра.
RULES_URLS = {
    'bybit': 'https://www.bybit.com/app/terms-service/information',
    'mexc': '',
    'htx': '',
    'gate': '',
    'bingx': '',
}


def rules_url_for(exchange_name):
    return RULES_URLS.get((exchange_name or '').strip().lower(), '')


# Обязательные поля профиля: атрибут User -> русское название для сообщения админу
PROFILE_FIELD_LABELS = {
    'last_name': 'Фамилия',
    'first_name': 'Имя',
    'registration_address': 'Адрес прописки',
    'phone': 'Телефон',
    'email': 'Email',
    'gender': 'Пол',
}


class DocumentError(ValueError):
    """Документ нельзя сформировать: список причин в .problems."""

    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__('; '.join(self.problems))


def missing_profile_fields(user, required):
    return [PROFILE_FIELD_LABELS[f] for f in required
            if not (getattr(user, f, '') or '').strip()]


def fill_docx(template_path, values):
    """
    Подставляет values {'{{TOKEN}}': 'значение'} в word/document.xml шаблона,
    возвращает bytes нового .docx. Падает, если какой-то токен формы не найден
    в шаблоне или в результате остались незаполненные токены.
    """
    with zipfile.ZipFile(template_path) as src:
        xml = src.read('word/document.xml').decode('utf-8')
        not_found = [t for t in values if t not in xml]
        if not_found:
            raise RuntimeError(f'В шаблоне нет токенов: {", ".join(not_found)}')
        for token, value in values.items():
            xml = xml.replace(token, escape(value or ''))
        left = sorted(set(_TOKEN_RE.findall(xml)))
        if left:
            raise RuntimeError(f'В шаблоне остались незаполненные токены: {", ".join(left)}')

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as dst:
            for item in src.infolist():
                data = xml.encode('utf-8') if item.filename == 'word/document.xml' else src.read(item.filename)
                dst.writestr(item, data)
    return buf.getvalue()


def _fio_full(user):
    parts = [user.last_name, user.first_name, getattr(user, 'middle_name', '')]
    return ' '.join(p.strip() for p in parts if p and p.strip())


def _fio_short(user):
    """'Фамилия И.О.' / 'Фамилия И.' без отчества."""
    initials = ''.join(f'{p.strip()[0]}.' for p in (user.first_name, getattr(user, 'middle_name', ''))
                       if p and p.strip())
    return f'{user.last_name.strip()} {initials}'.strip()


# ============================================================
# ФОРМЫ
# ============================================================

@dataclass
class DocumentForm:
    key: str
    title: str
    template: str
    filename_prefix: str
    required_profile: list
    build_values: Callable  # (user, params) -> {'{{TOKEN}}': str}
    validate_params: Callable = field(default=lambda params: [])


def _cb_161fz_validate(params):
    problems = []
    if not (params.get('exchange') or '').strip():
        problems.append('Не выбрана биржа')
    if not (params.get('rules_url') or '').strip():
        problems.append('Нужна ссылка на правила биржи')
    if not isinstance(params.get('date'), date):
        problems.append('Некорректная дата заявления')
    return problems


def _cb_161fz_values(user, params):
    female = user.gender == 'F'
    return {
        '{{FIO}}': _fio_full(user),
        '{{FIO_SHORT}}': _fio_short(user),
        '{{ADDRESS}}': user.registration_address.strip(),
        '{{PHONE}}': user.phone.strip(),
        '{{EMAIL}}': user.email.strip(),
        '{{DATE}}': params['date'].strftime('%d.%m.%Y'),
        '{{EXCHANGE}}': params['exchange'].strip(),
        '{{RULES_URL}}': params['rules_url'].strip(),
        # зарегистрирован(а), принимал(а), исполнил(а)
        '{{A}}': 'а' if female else '',
        # удостоверился / удостоверилась
        '{{ASSURED_END}}': 'лась' if female else 'лся',
    }


FORMS = {
    'cb_161fz_primary': DocumentForm(
        key='cb_161fz_primary',
        title='Первичное заявление в ЦБ по 161-ФЗ',
        template='cb_161fz_primary.docx',
        filename_prefix='Первичное_заявление_ЦБ_161-ФЗ',
        required_profile=['last_name', 'first_name', 'registration_address', 'phone', 'email', 'gender'],
        build_values=_cb_161fz_values,
        validate_params=_cb_161fz_validate,
    ),
}


def build_document(form_key, user, params):
    """
    Возвращает (filename, docx_bytes). DocumentError — если не хватает данных
    профиля или параметров формы (сообщения для админа в .problems).
    """
    form = FORMS.get(form_key)
    if not form:
        raise DocumentError(['Неизвестная форма документа'])

    problems = []
    missing = missing_profile_fields(user, form.required_profile)
    if missing:
        problems.append('В настройках пользователя не заполнено: ' + ', '.join(missing))
    problems += form.validate_params(params)
    if problems:
        raise DocumentError(problems)

    data = fill_docx(os.path.join(TEMPLATES_DIR, form.template), form.build_values(user, params))
    stamp = params['date'].strftime('%d%m%Y') if isinstance(params.get('date'), date) else ''
    filename = f'{form.filename_prefix}_{user.last_name.strip()}_{stamp}.docx'
    return filename, data
