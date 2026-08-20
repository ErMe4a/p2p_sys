import logging
from celery import shared_task
from .models import User, Order
from .bybit_api import sync_bybit_orders
from .mexc_api import sync_mexc_orders
from .models import UnprocessedOrder
logger = logging.getLogger(__name__)

# ── Расписание ретраев верификации ────────────────────────────────────────────
# ИСПРАВЛЕНО: было 5 попыток с фолбэком "бьём чек из БД". Теперь чек
# НИКОГДА не бьётся по неподтверждённым данным (кроме ручного режима) —
# вместо фолбэка длинное расписание ретраев до ~48 часов.
VERIFY_RETRY_SCHEDULE = [30, 60, 120, 300, 900, 1800]  # 30с,1м,2м,5м,15м,30м
VERIFY_HOURLY_DELAY = 3600                              # дальше — каждый час
VERIFY_MAX_RETRIES = len(VERIFY_RETRY_SCHEDULE) + 48    # ~48 часов суммарно


@shared_task(bind=True, max_retries=0, queue="sync")
def sync_bybit_orders_task(self):
    """
    ДИСПЕТЧЕР: раскидывает синк Bybit/MEXC по одной задаче на юзера,
    вместо одного большого последовательного цикла по всем сразу.

    ПОЧЕМУ: раньше это был один task, обходящий всех юзеров с валидным
    ключом ПОСЛЕДОВАТЕЛЬНО внутри себя — если у одного юзера зависал
    сетевой запрос к бирже (у bybit_p2p до фикса не было timeout вообще),
    весь task зависал на неопределённое время, занимая единственный
    воркер-слот, а beat каждые 30 минут докидывал новые запуски поверх —
    очередь "sync" копилась (обнаружено 218 застрявших). Теперь один
    подвисший/упавший юзер не блокирует остальных, и синк идёт параллельно
    в пределах доступного concurrency очереди "sync".
    """

    bybit_user_ids = list(
        User.objects
        .filter(bybit_key_valid=True)
        .exclude(bybit_api_key__isnull=True).exclude(bybit_api_key="")
        .exclude(bybit_api_secret__isnull=True).exclude(bybit_api_secret="")
        .values_list("id", flat=True)
    )
    for user_id in bybit_user_ids:
        sync_bybit_orders_for_user_task.apply_async(args=[user_id], queue="sync")

    mexc_user_ids = list(
        User.objects
        .filter(mexc_key_valid=True)
        .exclude(mexc_api_key__isnull=True).exclude(mexc_api_key="")
        .exclude(mexc_api_secret__isnull=True).exclude(mexc_api_secret="")
        .values_list("id", flat=True)
    )
    for user_id in mexc_user_ids:
        sync_mexc_orders_for_user_task.apply_async(args=[user_id], queue="sync")

    logger.info(
        "sync_bybit_orders_task: поставлено в очередь Bybit=%d, MEXC=%d задач.",
        len(bybit_user_ids), len(mexc_user_ids),
    )
    return {"bybit_users": len(bybit_user_ids), "mexc_users": len(mexc_user_ids)}


@shared_task(bind=True, max_retries=0, queue="sync")
def sync_bybit_orders_for_user_task(self, user_id):
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return 0
    try:
        added = sync_bybit_orders(user)
        if added > 0:
            logger.info("Bybit [%s]: +%d новых ордеров.", user.username, added)
        return added
    except Exception as e:
        logger.error("Bybit sync error [%s]: %s", user.username, e, exc_info=True)
        return 0


@shared_task(bind=True, max_retries=0, queue="sync")
def sync_mexc_orders_for_user_task(self, user_id):
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return 0
    try:
        added = sync_mexc_orders(user)
        if added > 0:
            logger.info("MEXC [%s]: +%d новых ордеров.", user.username, added)
        return added
    except Exception as e:
        logger.error("MEXC sync error [%s]: %s", user.username, e, exc_info=True)
        return 0


@shared_task(bind=True, max_retries=VERIFY_MAX_RETRIES, queue="receipt")
def verify_and_receipt_later(self, order_id: int):
    """
    Пробует получить данные ордера из API биржи и пробить чек.

    НОВЫЕ ПРАВИЛА (чек только из данных API):
      - Чек бьётся ТОЛЬКО после подтверждения данных API биржи
        (или в ручном режиме is_manual — данные оператора).
      - Фолбэк "попытки исчерпаны — бьём чек из БД" УДАЛЁН.
      - Расписание ретраев: 30с → 1м → 2м → 5м → 15м → 30м → далее
        каждый час, суммарно до ~48 часов.
      - Если ключ юзера помечен невалидным — ретраи останавливаются
        немедленно (без смысла долбить мёртвый ключ). После починки
        ключа зависшие ордера допробьёт retry_blocked_orders_task.
      - Если биржа так и не подтвердила ордер за ~48ч — ордер
        помечается verification_failed, чек не бьётся.
    """
    from .exchange_api import get_order_from_exchange

    try:
        o = Order.objects.get(id=order_id)
    except Order.DoesNotExist:
        logger.warning("verify_and_receipt_later: Order %d не найден.", order_id)
        return

    if o.is_verified:
        logger.info("verify_and_receipt_later: Order %d уже верифицирован.", order_id)
        _try_send_receipt(o)
        return

    if o.receipt and isinstance(o.receipt, dict) and o.receipt.get("uuid"):
        logger.info("verify_and_receipt_later: Order %d чек уже пробит.", order_id)
        return

    # ИСПРАВЛЕНО: если ключ уже помечен невалидным — не ретраим впустую.
    # Ордер останется неверифицированным до починки ключа юзером.
    ex_lower = str(o.exchange_type).lower()
    if "mexc" in ex_lower and not o.user.mexc_key_valid:
        logger.warning(
            "verify_and_receipt_later: Order %d — ключ MEXC юзера %s невалиден, "
            "ретраи остановлены. Допробьётся после починки ключа.",
            order_id, o.user.username,
        )
        return
    if "bybit" in ex_lower and not o.user.bybit_key_valid:
        logger.warning(
            "verify_and_receipt_later: Order %d — ключ Bybit юзера %s невалиден, "
            "ретраи остановлены. Допробьётся после починки ключа.",
            order_id, o.user.username,
        )
        return

    attempt = self.request.retries + 1
    logger.info("verify_and_receipt_later: Order %d [%s] попытка %d.", order_id, o.external_id, attempt)

    api_data = get_order_from_exchange(
        user=o.user,
        order_id=o.external_id,
        exchange_name=o.exchange_type,
        order_date=o.created_at,  # ИСПРАВЛЕНО: без этого pagination-поиск
        # стороны для MEXC искал в окне "последние 3 дня от текущего момента",
        # а не от даты создания ордера — для ордеров старше нескольких дней
        # (например, зависших и допробиваемых через retry_blocked_orders_task)
        # окно поиска промахивалось мимо реальной даты сделки, и верификация
        # проваливалась даже при рабочем ключе и существующем ордере.
    )

    if api_data:
        if o.is_manual:
            logger.info(
                "verify_and_receipt_later: Order %d — is_manual=True, "
                "данные из API игнорируем, оставляем данные пользователя "
                "price=%s cost=%s amount=%s",
                order_id, o.price, o.cost, o.amount,
            )
            o.is_verified = True
            o.save(update_fields=["is_verified"])
        else:
            o.price          = api_data["price"]
            o.cost           = api_data["cost"]
            o.amount         = api_data["amount"]
            o.operation_type = api_data["operation_type"]
            o.is_verified    = True
            update_fields = ["price", "cost", "amount", "operation_type", "is_verified"]

            # Валюта — авторитетно с биржи, та же логика, что и в
            # api_views.order() для мгновенной верификации (см. exchange_api.
            # _map_known_currency): только известные системе USDT/TON/BTC,
            # иначе не трогаем то, что уже было сохранено раньше.
            if api_data.get("currency"):
                o.currency = api_data["currency"]
                update_fields.append("currency")

            # Дата — авторитетно с биржи, если API её отдало (см. ту же
            # логику и обоснование в api_views.order): дата с расширения
            # могла быть не найдена на странице или сдвинута из-за
            # часового пояса браузера при первом создании ордера — здесь
            # она перезаписывается достоверной.
            if api_data.get("created_at"):
                o.created_at = api_data["created_at"]
                update_fields.append("created_at")

            o.save(update_fields=update_fields)

        UnprocessedOrder.objects.filter(
            user=o.user,
            order_id=o.external_id,
        ).delete()

        logger.info(
            "verify_and_receipt_later: Order %d верифицирован (manual=%s)",
            order_id, o.is_manual,
        )
        _try_send_receipt(o)

    else:
        # ИСПРАВЛЕНО: ключ мог быть помечен невалидным ПРЯМО СЕЙЧАС, внутри
        # только что отработавшего get_order_from_exchange (например поймали
        # код 700007) — перепроверяем перед тем, как ставить ретрай.
        o.user.refresh_from_db(fields=["mexc_key_valid", "bybit_key_valid"])
        if ("mexc" in ex_lower and not o.user.mexc_key_valid) or \
           ("bybit" in ex_lower and not o.user.bybit_key_valid):
            logger.warning(
                "verify_and_receipt_later: Order %d — ключ помечен невалидным "
                "в ходе запроса, ретраи остановлены.",
                order_id,
            )
            return

        if attempt <= VERIFY_MAX_RETRIES:
            # ИСПРАВЛЕНО: расписание вместо жёсткой формулы 30/120 * 2^n
            if attempt <= len(VERIFY_RETRY_SCHEDULE):
                countdown = VERIFY_RETRY_SCHEDULE[attempt - 1]
            else:
                countdown = VERIFY_HOURLY_DELAY

            logger.warning(
                "verify_and_receipt_later: Order %d — API не подтвердил, повтор через %d сек (попытка %d/%d).",
                order_id, countdown, attempt, VERIFY_MAX_RETRIES,
            )
            raise self.retry(countdown=countdown)
        else:
            # ИСПРАВЛЕНО: фолбэк "бьём чек из БД" удалён полностью.
            # Помечаем ордер как неподтверждённый — чек не бьётся, пока
            # юзер не решит вопрос сам (ручной режим или разбор ордера).
            current_receipt = o.receipt if isinstance(o.receipt, dict) else {}
            o.receipt = {
                **current_receipt,
                "verification_failed": True,
                "status": "VERIFICATION_FAILED",
            }
            o.save(update_fields=["receipt"])

            # Из "Необработанных" всё равно убираем — раз попытки исчерпаны,
            # дальше висеть там ему незачем, ордер уже не "необработанный",
            # он "неподтверждённый" (виден по receipt.status в интерфейсе).
            UnprocessedOrder.objects.filter(
                user=o.user,
                order_id=o.external_id,
            ).delete()

            logger.error(
                "verify_and_receipt_later: Order %d [%s] — биржа не подтвердила ордер "
                "за ~48ч. Чек НЕ пробит. Требуется ручное решение (manualEdit или разбор).",
                order_id, o.external_id,
            )


@shared_task(bind=True, max_retries=0, queue="receipt")
def retry_blocked_orders_task(self, user_id: int = None):
    """
    НОВОЕ: допробитие зависших ордеров после починки ключей.

    Вызывается из вьюхи настроек сразу после того, как юзер сохранил новый
    рабочий API-ключ (mexc_key_valid/bybit_key_valid снова стали True) —
    с user_id, чтобы сразу подхватить именно его зависшие ордера.

    Можно также поставить в Celery Beat раз в час без user_id как страховку.
    """
    qs = Order.objects.filter(is_verified=False, exchange_type__in=["Bybit", "MEXC"])
    if user_id:
        qs = qs.filter(user_id=user_id)

    requeued = 0
    for o in qs.select_related("user"):
        r = o.receipt if isinstance(o.receipt, dict) else {}
        if r.get("uuid") or r.get("verification_failed"):
            continue

        ex_lower = str(o.exchange_type).lower()
        if "mexc" in ex_lower and not o.user.mexc_key_valid:
            continue
        if "bybit" in ex_lower and not o.user.bybit_key_valid:
            continue

        verify_and_receipt_later.apply_async(args=[o.id], countdown=5, queue="receipt")
        requeued += 1

    if requeued:
        logger.info("retry_blocked_orders_task: перезапущено %d зависших ордеров (user_id=%s).", requeued, user_id)
    return requeued


def _try_send_receipt(order: Order):
    """
    Пробивает чек если есть contact и ненулевая сумма.
    Чек уже пробитый не трогаем.

    ИСПРАВЛЕНО: добавлен жёсткий барьер — чек бьётся ТОЛЬКО если ордер
    верифицирован через API (is_verified=True) или это осознанный ручной
    ввод (is_manual=True). Раньше сюда мог долететь вызов с неверифицированными
    данными расширения через фолбэк "5 попыток исчерпаны" — этот путь удалён
    в verify_and_receipt_later, но барьер здесь оставлен как вторая линия
    защиты на случай будущих вызовов этой функции из других мест.
    """
    from .receipt_service import create_or_update_and_send_receipt

    if order.receipt and isinstance(order.receipt, dict) and order.receipt.get("uuid"):
        return

    # ИСПРАВЛЕНО: жёсткая проверка источника данных перед любым дальнейшим шагом
    if not order.is_verified and not order.is_manual:
        logger.warning(
            "_try_send_receipt: Order %d — не верифицирован и не ручной, чек НЕ бьём.",
            order.id,
        )
        return

    receipt_dict = order.receipt if isinstance(order.receipt, dict) else {}
    contact = receipt_dict.get("contact")

    if not contact:
        logger.debug("_try_send_receipt: Order %d — нет contact, чек не нужен.", order.id)
        return

    if not order.cost or float(order.cost) == 0:
        logger.warning("_try_send_receipt: Order %d — нулевая сумма, чек не бьём.", order.id)
        return

    # ── ИСПРАВЛЕНИЕ ──────────────────────────────────────────────────────────
    # Берём финансовые данные из ордера (там либо данные API, либо осознанный
    # ручной ввод — в обоих случаях мы уже прошли барьер выше), а не из
    # плашки расширения, где курс мог прийти в копейках (79950 вместо 79.95).
    # contact берём из receipt_dict — его в API нет.
    receipt_dict = {
        **receipt_dict,
        "price":  float(order.price),
        "sum":    float(order.cost),
        "amount": float(order.amount),
    }
    logger.info(
        "_try_send_receipt: Order %d — подменяем данные чека из ордера (verified=%s, manual=%s): "
        "price=%s sum=%s amount=%s",
        order.id, order.is_verified, order.is_manual,
        float(order.price), float(order.cost), float(order.amount),
    )

    try:
        result = create_or_update_and_send_receipt(order, receipt_dict)
        logger.info(
            "_try_send_receipt: Order %d — чек отправлен, статус=%s uuid=%s",
            order.id,
            getattr(result, "status", None),
            getattr(result, "evotor_uuid", None),
        )
    except Exception as e:
        logger.error("_try_send_receipt: Order %d — ошибка: %s", order.id, e)


@shared_task(bind=True, max_retries=0, queue="receipt")
def recheck_mexc_keys_task(self):
    """
    Очередь "receipt", а не "sync" — эта задача логически с синком не
    связана (не пишет в UnprocessedOrder, только пробует ключ и разблокирует
    юзера), но раньше сидела на "sync" и страдала от того же затора.

    НОВОЕ: периодическая проверка "не ожил ли ключ MEXC сам по себе".

    В отличие от retry_blocked_orders_task (которую нужно вызывать явно
    после того, как юзер пересохранил ключ в настройках), этот таск не
    требует никакого действия от юзера в самой системе — он предназначен
    ровно для сценария "юзер просто включил галочку P2P на MEXC на том же
    самом ключе, ничего не пересохраняя у нас".

    Ставится в django_celery_beat раз в 30-60 минут. Проходит по всем
    юзерам с mexc_key_valid=False, пробует probe_mexc_key (лёгкий тестовый
    запрос) — если ключ ожил, сбрасывает флаг и запускает допробитие
    зависших ордеров этого юзера.
    """
    from .exchange_api import probe_mexc_key

    blocked_users = (
        User.objects
        .filter(mexc_key_valid=False)
        .exclude(mexc_api_key__isnull=True).exclude(mexc_api_key="")
        .exclude(mexc_api_secret__isnull=True).exclude(mexc_api_secret="")
    )

    recovered = 0
    for user in blocked_users:
        try:
            if probe_mexc_key(user):
                user.mexc_key_valid = True
                user.save(update_fields=["mexc_key_valid"])
                recovered += 1
                logger.info("recheck_mexc_keys_task: ключ MEXC [%s] снова рабочий, разблокирован.", user.username)

                retry_blocked_orders_task.apply_async(args=[user.id], queue="receipt")
        except Exception as e:
            logger.error("recheck_mexc_keys_task: ошибка проверки [%s]: %s", user.username, e, exc_info=True)

    if recovered:
        logger.info("recheck_mexc_keys_task: восстановлено %d ключей MEXC.", recovered)
    return recovered


@shared_task(bind=True, max_retries=0, queue="receipt")
def recompute_fns_status_task(self):
    """
    ДИСПЕТЧЕР: не считает статус сам, а раскидывает пересчёт по одной
    Celery-задаче на юзера (refresh_fns_status_for_user_task).

    ПОЧЕМУ ФАН-АУТ, А НЕ ОДИН БОЛЬШОЙ ЦИКЛ: на проде 122 юзера ОСНО/УСН
    (реально требуют тяжёлого расчёта - build_uvedomlenie/
    build_nds_declaration на всю глубину года), у части - по 3000-6600
    ордеров. Один последовательный таск на всех них был бы одним
    длинным блокирующим куском работы в очереди воркера.

    ПОЧЕМУ ОЧЕРЕДЬ "receipt", А НЕ "sync": на проде обнаружилось, что
    "sync" уже хронически забита (sync_bybit_orders_task/
    recheck_mexc_keys_task копятся быстрее, чем успевают выполняться,
    concurrency там всего ~1-3) - 122 моих задачи встали бы в хвост
    этой существующей пробки и не выполнились бы часами. "receipt"
    (celery-receipt.service, concurrency=8) оказалась гораздо свободнее.
    Семантически не идеально (это не про чеки), но прагматично - не
    требует новой очереди/сервиса. Если когда-нибудь заведут отдельную
    выделенную очередь под это - перенести туда.

    Сам диспетчер лёгкий (только id юзеров + apply_async) - выполняется
    почти мгновенно. Ставится в django_celery_beat КАЖДЫЕ 5 МИНУТ
    (queue="receipt").
    """
    # Тяжёлый расчёт (build_uvedomlenie/build_nds_declaration) реально
    # нужен только ОСНО/УСН - для остальных тратим время просто на вызов
    # и ValueError внутри. Сужаем сразу, чтобы не гонять лишних юзеров.
    user_ids = list(
        User.objects
        .filter(tax_type__in=["OSNO", "OCH", "USN_INCOME", "USN_INCOME_OUTCOME"])
        .values_list("id", flat=True)
    )

    for user_id in user_ids:
        refresh_fns_status_for_user_task.apply_async(args=[user_id], queue="receipt")

    logger.info("recompute_fns_status_task: поставлено в очередь %d задач.", len(user_ids))
    return len(user_ids)


@shared_task(bind=True, max_retries=0, queue="receipt")
def refresh_fns_status_for_user_task(self, user_id):
    """
    Пересчитывает User.fns_status_cached для ОДНОГО юзера и сохраняет
    в БД — как bybit_key_valid/mexc_key_valid, обычное поле, которое
    шаблон списка пользователей читает напрямую, без AJAX и без кэша.
    Ставится в очередь диспетчером recompute_fns_status_task, по одной
    задаче на юзера (см. его докстринг про причину фан-аута и выбора
    очереди "receipt").
    """
    from django.utils import timezone
    from .views import refresh_fns_status_cached

    try:
        user = User.objects.get(id=user_id)
        refresh_fns_status_cached(user, timezone.now().year)
    except User.DoesNotExist:
        return
    except Exception as e:
        logger.error("refresh_fns_status_for_user_task: ошибка для user_id=%s: %s", user_id, e, exc_info=True)


@shared_task(bind=True, max_retries=0, queue="receipt")
def recompute_yearly_profit_summary_task(self, year=None):
    """
    Пересчитывает MonthlySystemProfitSummary (грязная/чистая прибыль
    трейдеров и доход системы, по всем юзерам сразу) на каждый месяц
    указанного года — кэш для годовой сводки "2026" в админской "Прибыли"
    (custom_admin/profit_year.html, admin_profit_view ?month=year).

    Тяжёлый расчёт (LIFO по каждому юзеру, ~10 сек на 142 юзерах за один
    месяц в живом единичном запросе на обычной странице "Прибыль") — здесь
    считается не при заходе на страницу, а периодически в фоне (раз в час,
    настраивается в django_celery_beat — см. openspec/changes/add-monthly-
    profit-breakdown/design.md, решение №2).

    Оборот (buy/sell) сюда не входит — он дешёвый, страница считает его
    отдельно и live через views._year_turnover_by_month().
    """
    from collections import defaultdict
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from django.utils import timezone as dj_timezone
    from .models import MonthlySystemProfitSummary, UserExpense, MonthlyManualEntry
    from .views import SYSTEM_START, _calc_all_users_month_profit

    MSK = ZoneInfo('Europe/Moscow')
    if year is None:
        year = dj_timezone.now().year

    year_end = datetime(year + 1, 1, 1, tzinfo=MSK)
    users    = list(User.objects.all().order_by('id'))

    # Предзагрузка на весь год одним проходом — та же схема, что уже
    # использует admin_profit_view для одного месяца (views.py:2963+).
    raw_orders = (
        Order.objects
        .filter(created_at__gte=SYSTEM_START, created_at__lt=year_end)
        .order_by('user_id', 'created_at')
        .values_list(
            'id', 'user_id', 'created_at', 'currency', 'operation_type',
            'amount', 'cost', 'price', 'commission', 'commission_type',
            'exchange_type', 'bank_detail_id', 'exchange_commission_rate',
        )
    )

    class _O:
        __slots__ = (
            'id', 'user_id', 'created_at', 'currency', 'operation_type',
            'amount', 'cost', 'price', 'commission', 'commission_type',
            'exchange_type', 'bank_detail_id', 'exchange_commission_rate',
        )
        def __init__(self, row):
            (self.id, self.user_id, self.created_at, self.currency,
             self.operation_type, self.amount, self.cost, self.price,
             self.commission, self.commission_type, self.exchange_type,
             self.bank_detail_id, self.exchange_commission_rate) = row

    all_orders_by_user = defaultdict(list)
    for row in raw_orders:
        all_orders_by_user[row[1]].append(_O(row))

    expenses_by_user_month = defaultdict(float)
    for e in UserExpense.objects.filter(month__startswith=str(year)).values('user_id', 'month', 'amount'):
        expenses_by_user_month[(e['user_id'], e['month'])] += float(e['amount'])

    class _Manual:
        __slots__ = ('gross', 'sell_cost')
        def __init__(self, m):
            self.gross     = float(m.get('gross', 0) or 0)
            self.sell_cost = float(m.get('sell_cost', 0) or 0)

    manuals_by_user_month = {}
    for m in MonthlyManualEntry.objects.filter(month__startswith=str(year)).values('user_id', 'month', 'gross', 'sell_cost'):
        manuals_by_user_month[(m['user_id'], m['month'])] = _Manual(m)

    now_msk = dj_timezone.now().astimezone(MSK)

    for month in range(1, 13):
        if datetime(year, month, 1, tzinfo=MSK) > now_msk:
            continue  # будущий месяц — данных ещё не может быть, не считаем впустую

        totals = _calc_all_users_month_profit(
            users, year, month, all_orders_by_user,
            expenses_by_user_month, manuals_by_user_month,
        )

        for currency in ('all', 'usdt', 'ton'):
            MonthlySystemProfitSummary.objects.update_or_create(
                year=year, month=month, currency=currency,
                defaults={
                    'gross_traders': round(totals[f'gross_{currency}'], 2),
                    'net_traders':   round(totals[f'net_{currency}'], 2),
                    'system_income': round(totals[f'share_{currency}'], 2),
                },
            )

    logger.info("recompute_yearly_profit_summary_task: пересчитано за %d год.", year)
