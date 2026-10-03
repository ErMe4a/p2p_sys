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
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import date
from typing import Callable
from xml.sax.saxutils import escape

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'doc_templates')

_TOKEN_RE = re.compile(r'\{\{[A-Z_]+\}\}')

# Первичное заявление в ЦБ подаётся формально — биржа всегда Bybit (решение Максима),
# дата — день формирования.
CB_161FZ_EXCHANGE = 'Bybit'
CB_161FZ_RULES_URL = 'https://www.bybit.com/app/terms-service/information'


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
            if isinstance(value, (list, tuple)):
                xml = _repeat_paragraph(xml, token, value)
            else:
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


_PARA_RE = re.compile(r'<w:p[ >](?:(?!<w:p[ >]).)*?</w:p>', re.S)


def _repeat_paragraph(xml, token, items):
    """
    Абзац с токеном копируется на каждый элемент списка (например, строки
    «Приложение №N: …»). Нумерация списка Word в копиях убирается — номер уже в
    тексте, иначе выйдет «1. Приложение №1». Пустой список удаляет абзац.
    """
    for m in _PARA_RE.finditer(xml):
        para = m.group(0)
        if token in para:
            plain = re.sub(r'<w:numPr>.*?</w:numPr>', '', para, flags=re.S)
            copies = ''.join(plain.replace(token, escape(item)) for item in items)
            return xml[:m.start()] + copies + xml[m.end():]
    return xml


def parse_req_numbers(raw):
    """'req-1, REQ-2; REQ-1' -> ['REQ-1', 'REQ-2'] (порядок сохраняется, дубли убираются)."""
    out = []
    for part in re.split(r'[,;\s]+', raw or ''):
        part = part.strip().upper()
        if part and part not in out:
            out.append(part)
    return out


def merge_pdfs(parts):
    """Склеивает PDF (bytes) в один по порядку. Битый файл — ValueError с номером части."""
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    for i, data in enumerate(parts):
        try:
            reader = PdfReader(io.BytesIO(data))
            for page in reader.pages:
                writer.add_page(page)
        except Exception as e:
            raise ValueError(f'часть {i + 1}: {e}') from e
    buf = io.BytesIO()
    writer.write(buf)
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
class FormField:
    """Дополнительное поле формы на странице (у каждой формы свои)."""
    name: str
    label: str
    placeholder: str = ''
    suggest: str = ''  # 'banks' — подсказки из каталога банков


@dataclass
class DocumentForm:
    key: str
    title: str
    template: str
    filename_prefix: str
    required_profile: list
    build_values: Callable  # (user, params) -> {'{{TOKEN}}': str}
    fields: list = field(default_factory=list)  # все поля обязательны


def _cb_161fz_values(user, params):
    female = user.gender == 'F'
    return {
        '{{FIO}}': _fio_full(user),
        '{{FIO_SHORT}}': _fio_short(user),
        '{{ADDRESS}}': user.registration_address.strip(),
        '{{PHONE}}': user.phone.strip(),
        '{{EMAIL}}': user.email.strip(),
        '{{DATE}}': params['date'].strftime('%d.%m.%Y'),
        '{{EXCHANGE}}': CB_161FZ_EXCHANGE,
        '{{RULES_URL}}': CB_161FZ_RULES_URL,
        # зарегистрирован(а), принимал(а), исполнил(а)
        '{{A}}': 'а' if female else '',
        # удостоверился / удостоверилась
        '{{ASSURED_END}}': 'лась' if female else 'лся',
    }


OBDS_APPENDIX_DEFAULT = 'Решение ЦБ от отказе в исключении данных из базы.'  # текст шаблона Максима


def _obds_values(user, params):
    female = user.gender == 'F'
    reqs = parse_req_numbers(params['fields']['request_number'])
    appendices = params.get('appendices') or []  # [{'req': ...}, ...] — решения ЦБ, по порядку
    return {
        '{{APPENDIX}}': (
            [f'Приложение №{i}: Решение ЦБ об отказе в исключении данных из базы ({a["req"]})'
             for i, a in enumerate(appendices, 1)]
            or OBDS_APPENDIX_DEFAULT
        ),
        '{{BANK}}': params['fields']['bank'],
        '{{FIO}}': _fio_full(user),
        '{{FIO_SHORT}}': _fio_short(user),
        '{{ADDRESS}}': user.registration_address.strip(),
        '{{PHONE}}': user.phone.strip(),
        '{{EMAIL}}': user.email.strip(),
        '{{REQUEST}}': ', '.join(reqs),
        '{{DATE}}': params['date'].strftime('%d.%m.%Y'),
        # был(а) внесен(а), совершал(а), готов(а)
        '{{A}}': 'а' if female else '',
    }


FORMS = {
    'cb_161fz_primary': DocumentForm(
        key='cb_161fz_primary',
        title='Первичное заявление в ЦБ по 161-ФЗ',
        template='cb_161fz_primary.docx',
        filename_prefix='Первичное_заявление_ЦБ_161-ФЗ',
        required_profile=['last_name', 'first_name', 'registration_address', 'phone', 'email', 'gender'],
        build_values=_cb_161fz_values,
    ),
    'obds_request': DocumentForm(
        key='obds_request',
        title='Запрос данных по ОБДС',
        template='obds_request.docx',
        filename_prefix='Запрос_данных_ОБДС',
        required_profile=['last_name', 'first_name', 'registration_address', 'phone', 'email', 'gender'],
        build_values=_obds_values,
        fields=[
            FormField('bank', 'Банк (кому)', 'Например: ПАО Сбербанк', suggest='banks'),
            FormField('request_number', 'Номера запросов ЦБ', 'REQ-…, REQ-… (через запятую)'),
        ],
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
    values = params.get('fields') or {}
    for f in form.fields:
        if not (values.get(f.name) or '').strip():
            problems.append(f'Не заполнено поле «{f.label}»')
    if problems:
        raise DocumentError(problems)

    data = fill_docx(os.path.join(TEMPLATES_DIR, form.template), form.build_values(user, params))
    stamp = params['date'].strftime('%d%m%Y') if isinstance(params.get('date'), date) else ''
    filename = f'{form.filename_prefix}_{user.last_name.strip()}_{stamp}.docx'
    return filename, data


def docx_to_pdf(docx_bytes, timeout=60):
    """
    Конвертирует .docx в PDF через LibreOffice (headless, пакет libreoffice-writer-nogui
    на сервере). Отдельный профиль LibreOffice на каждый вызов во временной папке:
    у www-data нет записываемого HOME, а общий профиль не даёт параллельных конвертаций.
    """
    soffice = shutil.which('soffice') or shutil.which('libreoffice')
    if not soffice:
        raise RuntimeError('На сервере не установлен LibreOffice — PDF сформировать нельзя.')
    with tempfile.TemporaryDirectory(prefix='doc2pdf_') as tmp:
        src = os.path.join(tmp, 'document.docx')
        with open(src, 'wb') as f:
            f.write(docx_bytes)
        subprocess.run(
            [soffice, f'-env:UserInstallation=file://{tmp}/profile', '--headless',
             '--convert-to', 'pdf', '--outdir', tmp, src],
            check=True, timeout=timeout, capture_output=True,
        )
        with open(os.path.join(tmp, 'document.pdf'), 'rb') as f:
            return f.read()

