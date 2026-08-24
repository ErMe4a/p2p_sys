# p2p_sys — project.md

Django-бэкенд (mininp2p.ru), трекает P2P крипто-ордера трейдеров (Bybit, MEXC, HTX, Gate, BingX, Telegram и др.),
верифицирует их через API биржи и фискализирует как чек через Evotor/Atol. Плюс налоговая отчётность (НДС,
уведомления) и админ-панель для оборота/прибыли. Компаньон — Chrome-расширение `minin-p2p/` (Manifest V3),
отдельный JS-проект, скрейпит данные со страниц бирж и шлёт их в REST API бэкенда.

## Стек

- **Backend:** Django 5.2.9 + Django REST Framework 3.16.1, Python (venv в репозитории).
- **БД:** PostgreSQL (`psycopg2-binary`), продакшен через `DATABASE_URL`.
- **Очереди/фон:** Celery 5.6.2 + Redis (broker), `django_celery_beat` — периодика настраивается в БД/админке, не в коде.
- **Биржевые интеграции:** `bybit_p2p` (vendored-копия пакета в корне репо — теневой приоритет над `venv/`), `pybit`, самописный REST-клиент для MEXC (`mexc_api.py`/`mexc_service.py`).
- **Файлы/медиа:** локально по умолчанию; S3 (Yandex Cloud, `django-storages`/`boto3`) — если заданы AWS-переменные.
- **Отчёты:** `openpyxl` (Excel), самописная генерация XML для НДС/уведомлений (`nds_generator.py`, `uvedomlenie_generator.py`).
- **Прод-сервер:** gunicorn + systemd (`p2p.service`, `celery.service`, `celery-sync.service`, `celery-receipt.service`, `celerybeat.service`), nginx перед ним. Деплой — `git pull` → `migrate` → `restart`, вручную по SSH, без CI/CD.
- **Фронтенд:** серверный Django-темплейтинг + Bootstrap 5.3 (тёмная/светлая тема через `data-bs-theme` + CSS-переменные) + ванильный JS (без сборщика/фреймворка).
- **Расширение (`minin-p2p/`):** Chrome Manifest V3, ванильный JS, отдельные content-скрипты на биржу (`content.js`=Bybit, `mexc.js`, `htx.js`, `gate.js`, `bingx.js`), общий `auth.js`/`order_api.js` для связи с бэкендом.
- Тестов нет (`orders/tests.py` — пустой шаблон), линтера/CI нет — единственная проверка перед деплоем: ручной прогон.

## Архитектура (фактическая структура папок)

```
core/                    # Django-проект: settings.py, urls.py (роутинг: '' → orders.urls, 'api/' → orders.api_urls), celery.py
orders/                  # единственное Django-приложение — вся бизнес-логика тут
  models.py              # User(AbstractUser), Order, BankDetail, Exchange, UnprocessedOrder, IgnoredOrder,
                          #   MonthlyManualEntry, BalanceCorrection, DocumentSubmission, OrderScreenshot
  views.py                # ~3900+ строк: юзер-вьюхи (мои ордера/настройки/прибыль/ФНС) + вся кастомная админка
                          #   в одном файле — искать по имени функции, не читать целиком
  api_views.py            # DRF-эндпоинты для расширения (TokenAuth/Bearer, orders/authentication.py)
  urls.py / api_urls.py   # роуты для серверного HTML и для REST API соответственно
  tasks.py                # Celery-задачи: sync_*_orders_task (fan-out по юзерам), verify_and_receipt_later
                          #   (ретраи верификации до ~48ч), retry_blocked_orders_task, recheck_mexc_keys_task,
                          #   recompute_fns_status_task
  bybit_api.py / mexc_api.py         # персистентный sync-путь (пишет в UnprocessedOrder/Order)
  bybit_service.py / mexc_service.py # параллельный read-only путь для live-вьюх админки (ничего не пишет)
  exchange_api.py         # единая точка верификации ордера через API биржи (Bybit/MEXC, авторитетный источник)
  receipt_service.py + evotor_atol.py # сборка и отправка чека в Evotor/Atol v5
  nds_generator.py / uvedomlenie_generator.py # налоговые XML-документы
  migrations/             # 36 миграций, актуальная схема — до 0036 (MonthlySystemProfitSummary, кэш годовой прибыли)
  templates/
    orders/               # юзер-фронт: my_orders, settings, profit, fns, unprocessed (extends base.html)
    custom_admin/         # кастомная админка: users_list, profit_list, profit_year, orders_editor,
                          #   turnover_control, statistics_24, fns_documents, catalog, login, admin_base.html
    registration/login.html
bybit_p2p/                # vendored-копия пакета bybit_p2p — правки биржевого клиента вносятся ЗДЕСЬ, не в venv/
minin-p2p/                 # Chrome-расширение (отдельный JS-проект), версия 1.5.0
openspec/                  # spec-driven workflow (эта система), history.md — копия SESSION_LOG.md
venv/                       # виртуальное окружение (закоммичено в репо)
CLAUDE.md, AUDIT_PLAN.md, SESSION_LOG.md  # ручная документация проекта и лог сессий
```

**Два независимых пути получения ордеров с биржи** — не путать: `bybit_api.py`/`mexc_api.py` (периодический sync,
пишет в БД) vs `bybit_service.py`/`mexc_service.py` (параллельный live-запрос для админки, ничего не сохраняет).

**Инвариант фискализации:** чек уходит только по `is_verified=True` (подтверждено API биржи) или `is_manual=True`
(осознанный ручной ввод) — фолбэк на непроверенные данные расширения запрещён и физически убран из кода.

## Текущий статус приложения

**Стабильно работает и в проде:** синк Bybit/MEXC, верификация + автофискализация чеков (для Bybit/MEXC — через
API; для остальных бирж — по ручному вводу), валюта ордера (USDT/TON/BTC) для Bybit/MEXC теперь тоже определяется
через API биржи (`tokenId`/`coinName`), не только с расширения, НДС/уведомления (вкл. порог 20 млн для УСН),
светлая/тёмная тема на всех страницах, каталог банков/бирж (`custom_admin/catalog.html`, добавление/скрытие/
переименование банков), персональный выбор видимых банков/бирж на `/settings/`, вкладка «2026» в админ-«Прибыли» —
**оборот И помесячная грязная/чистая прибыль трейдеров/доход системы** по всем юзерам сразу (фоновый кэш,
`MonthlySystemProfitSummary`, пересчёт раз в час, см. `openspec/changes/add-monthly-profit-breakdown` — change
закрыт технически, задачи выполнены, архивация не запрошена).

**Известные незакрытые проблемы (см. `openspec/history.md` для деталей):**
- Отправка чека при мгновенной верификации Bybit/MEXC — синхронный вызов внутри HTTP-запроса от расширения, без
  единого ретрая при сбое Evotor; ответ API всегда `success:true` независимо от статуса чека — расширение эту
  ошибку не показывает пользователю.
- Ручная форма "Мои ордера" не валидирует дату (`created_at`) на "не в будущем" — уже приводило к ордерам с датой
  в следующем месяце, искажающим отчётность.
- Ордера, созданные через ручную форму, никогда не получают `is_manual=True` — из-за этого при сбое отправки чека
  для них нет вообще никакого автоматического пути повтора (ни verify-ретраев, ни recheck-задач).
- Расширение (`minin-p2p/auth.js`) при HTTP 403 от бэкенда, не подошедшем под известные текстовые шаблоны, всегда
  трактует это как "истекла сессия" и разлогинивает юзера — маскирует настоящую причину (например, невалидный
  биржевой ключ) понятным, но неверным сообщением.
- На странице «Прибыль» трейдера (`profit.html`) кнопка вкладки называется "За текущий месяц", но реально считает
  строго один день (id/логика — `today`) — название разошлось с поведением из-за случайной правки в чужом коммите
  (см. history.md §41). Не исправлено, ждёт решения.
- На той же вкладке карточки "Покупки/Продажи" считаются за выбранный день, а карточки "Прибыль" — всегда за весь
  текущий календарный месяц, независимо от выбранного диапазона дат — архитектурная особенность (не баг), сбивает
  трейдеров с толку (см. history.md §42, инцидент sedurin). Решение, как это должно работать, не принято.
- Ручной ввод комиссии на форме "Мои ордера" не защищён от смешения "комиссия банка" и "комиссия биржи" в голове
  трейдера (валидация ловит только явно нелепые значения >5%, не сам факт подмены поля) — см. history.md §42,
  реальный инцидент на 307 ордерах одного юзера.
- Несколько открытых вопросов по конкретным пользователям/документам (импорт январских сделок из Excel, дата
  регистрации ИП для расчёта периода НДС) — решения ждут ответа от Макса.

**Прод:** `89.169.143.100`, `/opt/p2p_sys`, деплой вручную по SSH (`git pull` → `migrate` при новых миграциях →
`systemctl restart p2p` [+ `celery*`, если правка касается `tasks.py`/импортируемых им модулей).
