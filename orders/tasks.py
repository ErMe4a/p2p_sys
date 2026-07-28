import logging
from celery import shared_task
from .models import User, Order
from .bybit_api import sync_bybit_orders
from .mexc_api import sync_mexc_orders
from .models import UnprocessedOrder

logger = logging.getLogger(__name__)

MAX_EVOTOR_REPORT_RETRIES = 6  # 30с,60с,120с,240с,240с,240с ~ до 15 минут

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
    Синхронизирует завершённые ордера Bybit и MEXC для всех пользователей.
    Пишет в UnprocessedOrder.
    Юзеры с невалидными ключами пропускаются.
    """

    bybit_users = (
        User.objects
        .filter(bybit_key_valid=True)
        .exclude(bybit_api_key__isnull=True).exclude(bybit_api_key="")
        .exclude(bybit_api_secret__isnull=True).exclude(bybit_api_secret="")
    )

    bybit_total = 0
    for user in bybit_users:
        try:
            added = sync_bybit_orders(user)
            if added > 0:
                bybit_total += added
                logger.info("Bybit [%s]: +%d новых ордеров.", user.username, added)
        except Exception as e:
            logger.error("Bybit sync error [%s]: %s", user.username, e, exc_info=True)

    mexc_users = (
        User.objects
        .filter(mexc_key_valid=True)
        .exclude(mexc_api_key__isnull=True).exclude(mexc_api_key="")
        .exclude(mexc_api_secret__isnull=True).exclude(mexc_api_secret="")
    )

    mexc_total = 0
    for user in mexc_users:
        try:
            added = sync_mexc_orders(user)
            if added > 0:
                mexc_total += added
                logger.info("MEXC [%s]: +%d новых ордеров.", user.username, added)
        except Exception as e:
            logger.error("MEXC sync error [%s]: %s", user.username, e, exc_info=True)

    logger.info("Sync завершена. Bybit: +%d, MEXC: +%d", bybit_total, mexc_total)
    return {"bybit": bybit_total, "mexc": mexc_total}


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
            o.save(update_fields=["price", "cost", "amount", "operation_type", "is_verified"])

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




@shared_task(bind=True, max_retries=0, queue="sync")
def recheck_mexc_keys_task(self):
    """
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