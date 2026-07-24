# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Django backend ("p2p_sys" / mininp2p.ru) that tracks P2P crypto-exchange orders (Bybit, MEXC, HTX, Gate, BingX) for
several traders, verifies each order against the exchange's own API, and — once verified — automatically fiscalizes
it as a cash receipt via the Evotor/Atol POS API. It also generates Russian tax-reporting documents (НДС,
уведомление об исчисленных суммах) and an admin panel for turnover/profit analysis.

A companion browser extension lives in `minin-p2p/` (separate, unrelated JS project, Manifest V3) — it scrapes order
data from exchange P2P web pages and pushes it to this backend's REST API under `/api/`. Treat it as a separate
codebase; changes there don't need a Django context.

## Commands

There is no configured linter, formatter, or CI. `orders/tests.py` is the stock empty Django test stub — there is no
real test suite; verify changes by running the dev server / relevant Celery task manually.

```bash
# Activate the existing venv (Windows) before anything else
venv\Scripts\activate

python manage.py runserver
python manage.py migrate
python manage.py makemigrations orders
python manage.py shell

# Celery (queues used: "sync", "receipt" — see orders/tasks.py)
celery -A core worker -l info -Q sync,receipt
# Periodic tasks (sync_bybit_orders_task, recheck_mexc_keys_task, retry_blocked_orders_task)
# are scheduled via django_celery_beat, configured in the DB/admin, not in code.
celery -A core beat -l info
```

`requirements.txt` is saved as UTF-16 — if `pip install -r requirements.txt` fails to parse it, re-save as UTF-8
before installing rather than editing package pins blind.

`.env` (see `.env.example`) drives `core/settings.py` via `django-environ`: `DATABASE_URL` (Postgres),
`CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND` (Redis), and S3 media storage (Yandex Cloud) which only activates when
`AWS_ACCESS_KEY_ID` is set — otherwise media falls back to local `MEDIA_ROOT`.

`audit_orders_2026.py` is a **read-only** ad-hoc analysis script, run with `python manage.py shell <
audit_orders_2026.py`; it writes an `.xlsx` anomaly report and never touches the DB.

## Architecture

Everything lives in one Django app, `orders/`, under project `core/`. There is no separation between "web app" and
"API" at the app level — both are routed from the same app, just different URL confs:

- `core/urls.py` → `path('', include('orders.urls'))` — server-rendered HTML views (login-based, session auth) for
  end users (`/my-orders/`, `/settings/`, `/fns/`, `/profit/`) and for the custom superuser admin panel under
  `/p2p-admin/` and `/admin-panel/` (separate from Django's built-in `/admin/`, with its own `admin_login`/
  `admin_logout` views and `@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')` gating).
- `core/urls.py` → `path("api/", include("orders.api_urls"))` — REST endpoints (DRF) consumed by the Chrome
  extension. Auth here is `TokenAuthentication` or the custom `Bearer` scheme (`orders/authentication.py`), not
  Django sessions.

`orders/views.py` is a single ~3900-line file holding both the end-user views and the entire admin panel (profit
calc, LIFO cost-basis, NDFL tax calc, Excel export, manual monthly entries, turnover control). When editing, grep for
the function name rather than trying to read the file end to end.

### Order lifecycle and the verification/receipt invariant

This is the most important cross-file flow in the codebase — read it before touching anything receipt- or
verification-related:

1. The extension POSTs a scraped order to `orders.api_views.order` (`POST /api/order`).
2. The server tries `exchange_api.get_order_from_exchange()` to fetch the *authoritative* price/cost/amount/side
   directly from the exchange API. Only Bybit and MEXC support this (direct single-order lookup); HTX/Gate/BingX/
   Telegram have no such endpoint and always rely on what the extension scraped.
3. If verified this way (or `is_manual=True`, i.e. a human explicitly typed the numbers in), `Order.is_verified` is
   set and a fiscal receipt is sent immediately via `receipt_service.create_or_update_and_send_receipt`.
4. If not verified, the order is saved as-is but the Celery task `tasks.verify_and_receipt_later` is scheduled to
   keep retrying against the exchange API on a backoff schedule (30s → 1m → 2m → 5m → 15m → 30m → hourly, up to
   ~48h total, see `VERIFY_RETRY_SCHEDULE`/`VERIFY_MAX_RETRIES`).
5. **Hard rule (enforced in both `tasks._try_send_receipt` and `api_views.order`): a fiscal receipt is only ever
   built from `is_verified` or `is_manual` data. There is no fallback to unverified extension data.** If the exchange
   never confirms the order within ~48h, it's marked `receipt.status = "VERIFICATION_FAILED"` and left for manual
   resolution — it is never auto-fiscalized on unconfirmed numbers. Recent commit history ("аудит" commits) is
   largely about removing older fallback paths that violated this rule; don't reintroduce them.

### API key health tracking

`User.bybit_key_valid` / `User.mexc_key_valid` gate almost everything exchange-related. They're flipped to `False`
by `exchange_api.py` / `bybit_api.py` when the exchange returns a known invalid-key error code
(`BYBIT_INVALID_KEY_CODES`, `MEXC_INVALID_KEY_CODES` — including MEXC's 700007 "P2P permission not enabled on key").
Once flagged, sync and verification tasks skip that user rather than retrying a dead key. Recovery is two-path:
explicit (user re-saves a key in settings → view calls `tasks.retry_blocked_orders_task`) or passive
(`tasks.recheck_mexc_keys_task`, periodic, probes MEXC keys marked invalid to see if the user re-enabled P2P without
touching this system).

MEXC has a documented quirk (see `exchange_api._get_mexc_order` docstring): the `side` field on the single-order
detail endpoint is inverted relative to reality, confirmed against the pagination endpoint. Price/amount are trusted
from `order/detail`; the BUY/SELL side is always re-derived from the pagination endpoint instead.

### Two independent order-fetching paths — don't conflate them

- `bybit_api.py` / `mexc_api.py`: the **persistent sync path**, run by the periodic `tasks.sync_bybit_orders_task`.
  Writes newly-seen completed orders into `UnprocessedOrder` (orders seen on the exchange but not yet created via
  the extension flow above).
- `bybit_service.py` / `mexc_service.py`: an **in-memory, read-only, parallel-fetch path** (`ThreadPoolExecutor`,
  10 workers) used by the admin panel's live "last 24h" views. Returns lightweight `DisplayOrder` objects that mimic
  Django model instances for template rendering; nothing is persisted here.

### Fiscalization and tax documents

- `receipt_service.py` + `evotor_atol.py`: builds and sends the Evotor/Atol v5 receipt payload. Requires
  `evotor_login`/`evotor_password`/`kkt_id`/`inn` on the `User`; the "место расчётов" (place of settlement) is
  derived from `order.exchange_type`, not stored per-user. Receipts for `exchange_type` containing "intelion" are
  intentionally skipped.
- `nds_generator.py` / `uvedomlenie_generator.py`: generate the NDS and "уведомление" tax documents (xlsx/output),
  driven from `DocumentSubmission` tracking which periods have been submitted per user.
- Profit/turnover math (LIFO cost basis, NDFL, currency-specific medians) lives inline in `views.py` as private
  `_calc_*` helpers rather than a separate module — search there when adjusting tax/profit calculations.

### `bybit_p2p/`

A vendored copy of the `bybit_p2p` PyPI package (also pinned in `requirements.txt` and present in
`venv/Lib/site-packages`). Because it sits at the project root, it shadows the installed package on `sys.path`. It's
currently byte-identical to the installed version, but if Bybit's API needs a local patch, this is the copy that
actually gets imported (`from bybit_p2p import P2P`) — edit here, not in `venv/`.
