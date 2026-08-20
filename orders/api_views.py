from django.contrib.auth import authenticate
from django.http import FileResponse, Http404
from django.utils.dateparse import parse_datetime
from django.db import transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from rest_framework.authtoken.models import Token

from .models import BankDetail, Order, UnprocessedOrder
from .receipt_service import should_make_receipt, create_or_update_and_send_receipt
from .exchange_api import get_order_from_exchange

import logging
logger = logging.getLogger(__name__)

EXCHANGE_ID_TO_NAME = {
    1: "Bybit",
    2: "HTX",
    3: "MEXC",
    4: "Gate",
    5: "BingX",
}

EXCHANGE_NAME_TO_ID = {
    "Bybit": 1, "BYBIT": 1,
    "HTX": 2,
    "MEXC": 3,
    "Gate": 4, "GATE": 4,
    "BingX": 5, "BINGX": 5,
}

MAX_COMMISSION_PERCENT = 5.0

def get_exchange_id(name):
    return EXCHANGE_NAME_TO_ID.get(str(name), 1)

def get_exchange_name(id_input):
    try:
        return EXCHANGE_ID_TO_NAME.get(int(id_input), "Bybit")
    except:
        return "Bybit"


# ---------- AUTH ----------
@api_view(["POST"])
@permission_classes([AllowAny])
def auth_login(request):
    user = authenticate(
        username=request.data.get("login"),
        password=request.data.get("password"),
    )
    if not user:
        return Response({"message": "Неверный логин или пароль"}, status=status.HTTP_401_UNAUTHORIZED)
    token, _ = Token.objects.get_or_create(user=user)
    return Response({
        "token": token.key,
        "tokenType": "Token",
        "userId": user.id,
        "login": user.username,
    })


# ---------- USER ----------
@api_view(["GET", "PUT"])
@permission_classes([IsAuthenticated])
def users_me(request):
    u = request.user
    if request.method == "GET":
        return Response({
            "id": u.id,
            "login": u.username,
            "inn": getattr(u, "inn", "") or "",
            "kktId": getattr(u, "kkt_id", "") or "",
            "paymentAddress": getattr(u, "payment_address", "") or "",
            "taxType": getattr(u, "tax_type", "") or "",
            "evotorLogin": getattr(u, "evotor_login", "") or "",
            "evotorPassword": getattr(u, "evotor_password", "") or "",
        })
    mapping = {
        "inn": "inn", "kktId": "kkt_id", "paymentAddress": "payment_address",
        "taxType": "tax_type", "evotorLogin": "evotor_login", "evotorPassword": "evotor_password",
    }
    for k, field in mapping.items():
        if k in request.data:
            setattr(u, field, request.data.get(k))
    u.save()
    return Response({"success": True})


# ---------- DETAILS ----------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def details(request):
    if request.method == "GET":
        qs = request.user.visible_banks.filter(is_deleted=False).order_by("id")
        return Response([{"id": d.id, "name": d.name} for d in qs])
    return Response({"message": "Creating banks is disabled via API"}, status=403)


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def details_delete(request, pk: int):
    return Response({"message": "Deletion disabled"}, status=403)


# ---------- ORDER ----------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def order(request):
    # === GET ===
    # ВРЕМЕННО ОТКАЧЕНО: сервер снова отвечает как раньше (404 + без
    # exists/hint) — пока пользователи на расширении 1.4.7, а не 1.4.8.
    # У MEXC (mexc.js, старый checkOrderExists) "ордер существует"
    # определялось просто по факту HTTP 200 — если сервер всегда отдаёт
    # 200 (как в версии с hint), это сломало бы существующих юзеров на
    # 1.4.7 прямо сейчас, ещё до всякого обновления расширения. Заготовка
    # с hint (для предзаполнения формы из UnprocessedOrder) оставлена в
    # content.js/mexc.js/order_api.js — код там уже готов и включится
    # сам, как только это же самое (exists/hint) снова появится здесь,
    # когда версия 1.4.8 будет раздана пользователям.
    if request.method == "GET":
        order_id    = (request.query_params.get("id") or "").strip()
        exchange_name = get_exchange_name(request.query_params.get("exchangeType", 1))
        if not order_id:
            return Response({"message": "id is required"}, status=400)
        o = Order.objects.filter(user=request.user, external_id=str(order_id), exchange_type=exchange_name).first()
        if not o:
            return Response({"message": "not found"}, status=404)
        receipt_data = None
        if o.receipt and isinstance(o.receipt, dict) and o.receipt.get("uuid"):
            receipt_data = o.receipt
        return Response({
            "id": o.id,
            "orderId": o.external_id,
            "exchangeType": get_exchange_id(o.exchange_type),
            "type": o.operation_type,
            "commission": str(getattr(o, "commission", 0)),
            "commissionType": getattr(o, "commission_type", "PERCENT"),
            "details": {"id": o.bank_detail_id} if getattr(o, "bank_detail_id", None) else None,
            "created_at": o.created_at.isoformat() if getattr(o, "created_at", None) else None,
            "price": str(getattr(o, "price", 0)),
            "amount": str(getattr(o, "cost", 0)),
            "quantity": str(getattr(o, "amount", 0)),
            "receipt": receipt_data,
            "isManual": getattr(o, "is_manual", False),
        })

    # === POST ===
    data = request.data

    external_id = str(data.get("orderId") or data.get("stringOrderId") or "").strip()
    if not external_id:
        return Response({"message": "orderId required"}, status=400)

    exchange_name = get_exchange_name(data.get("exchangeType", 1))

    # ИСПРАВЛЕНО: тексты стали конкретнее — юзер сразу видит, что чинить,
    # а не просто "недействителен".
    if exchange_name == "Bybit" and not request.user.bybit_key_valid:
        return Response({
            "success": False,
            "message": "Неправильно настроены API ключи Bybit (ключ недействителен "
                       "или истёк). Обновите ключ в настройках — зависшие ордера "
                       "допробьются автоматически."
        }, status=403)

    if exchange_name == "MEXC" and not request.user.mexc_key_valid:
        return Response({
            "success": False,
            "message": "Неправильно настроены API ключи MEXC. Проверьте: 1) ключ "
                       "действителен, 2) в настройках ключа на MEXC включена "
                       "галочка 'P2P' (MEXC обновил настройки ключей — её нужно "
                       "включить заново), 3) нет IP-ограничения. Обновите ключ в "
                       "настройках — зависшие ордера допробьются автоматически."
        }, status=403)

    commission      = data.get("commission") or 0
    commission_type = data.get("commissionType", "PERCENT")
    is_manual       = bool(data.get("manualEdit", False))

    # ИСПРАВЛЕНО: раньше currency вообще не читалась из payload — все ордера
    # с расширения молча получали дефолт модели (USDT), независимо от того,
    # что реально выбрано в форме (при ручном редактировании).
    currency = str(data.get("currency") or "").strip().upper()
    if currency not in ("USDT", "TON", "BTC"):
        currency = None  # не трогаем текущее значение при обновлении / дефолт модели при создании

    # ── Защита от ошибочного ввода комиссии (опечатки типа 50 вместо 0.5) ──
    try:
        commission_value = float(commission)
    except (TypeError, ValueError):
        commission_value = 0

    if commission_type == "PERCENT" and commission_value > MAX_COMMISSION_PERCENT:
        return Response({
            "success": False,
            "message": f"Комиссия {commission_value}% превышает максимально допустимую ({MAX_COMMISSION_PERCENT}%). Проверьте корректность ввода."
        }, status=400)
    # ─────────────────────────────────────────────────────────────────────

    created_at = None
    if "createdAt" in data:
        created_at = parse_datetime(data.get("createdAt"))

    bank = None
    details_obj = data.get("details")
    if isinstance(details_obj, dict):
        bank_id = details_obj.get("id")
        if bank_id:
            bank = BankDetail.objects.filter(id=bank_id, is_deleted=False).first()
    elif isinstance(details_obj, int):
        bank = BankDetail.objects.filter(id=details_obj, is_deleted=False).first()

    receipt_data_raw = data.get("receipt")
    receipt_dict = receipt_data_raw if isinstance(receipt_data_raw, dict) else {}

    if is_manual:
        price       = data.get("price") or receipt_dict.get("price") or 0
        cost        = data.get("amount") or receipt_dict.get("sum") or 0
        amount      = data.get("quantity") or receipt_dict.get("amount") or 0
        op_type     = str(data.get("type") or "BUY").strip().upper()
        is_verified = True
        logger.info(
            "Order %s [%s]: ручное редактирование — price=%s cost=%s amount=%s type=%s",
            external_id, exchange_name, price, cost, amount, op_type,
        )
    else:
        api_data = get_order_from_exchange(
            user=request.user,
            order_id=external_id,
            exchange_name=exchange_name,
            order_date=created_at,
        )

        if api_data:
            price       = api_data["price"]
            cost        = api_data["cost"]
            amount      = api_data["amount"]
            op_type     = api_data["operation_type"]
            is_verified = True

            # Валюта — приоритет у API биржи (tokenId у Bybit, coinName у
            # MEXC), а не у того, что выбрал трейдер в расширении — та же
            # логика, что уже применяется к price/cost/amount/типу сделки
            # чуть выше. get_order_from_exchange() кладёт сюда только
            # известные системе валюты (USDT/TON/BTC), иначе ключа просто
            # нет — тогда остаётся то, что прислало расширение.
            if api_data.get("currency"):
                currency = api_data["currency"]

            # Дата создания — приоритет у API биржи, а не у расширения.
            # DOM-парсинг на странице хрупкий (ломается при обновлениях
            # вёрстки) и, что хуже, JS-парсинг "YYYY-MM-DD HH:MM:SS" через
            # new Date(...) трактует строку как ЛОКАЛЬНОЕ время браузера —
            # если часовой пояс ОС трейдера не совпадает с тем, что рисует
            # Bybit, дата тихо съезжает на несколько часов без всякой
            # ошибки. API отдаёт мс-таймстамп напрямую от биржи — это
            # авторитетный источник, используем его всегда, когда доступен.
            # Данные с расширения — только запасной вариант, если по
            # какой-то причине API не вернул дату.
            if api_data.get("created_at"):
                if created_at and created_at != api_data["created_at"]:
                    logger.info(
                        "Order %s [%s]: дата с расширения (%s) отличается от даты API (%s) — берём API.",
                        external_id, exchange_name, created_at, api_data["created_at"],
                    )
                created_at = api_data["created_at"]
            elif not created_at:
                logger.warning(
                    "Order %s [%s]: дата не пришла ни с расширения, ни из API — будет проставлена дата отправки.",
                    external_id, exchange_name,
                )

            logger.info(
                "Order %s [%s]: данные из API — price=%s cost=%s amount=%s type=%s",
                external_id, exchange_name, price, cost, amount, op_type,
            )
        else:
            price       = data.get("price") or receipt_dict.get("price") or 0
            cost        = data.get("amount") or receipt_dict.get("sum") or 0
            amount      = data.get("quantity") or receipt_dict.get("amount") or 0
            op_type     = str(data.get("type") or "BUY").strip().upper()
            is_verified = exchange_name not in ("Bybit", "MEXC")
            if not is_verified:
                logger.warning(
                    "Order %s [%s]: API не вернул данные — сохраняем с данными расширения, чек откладываем.",
                    external_id, exchange_name,
                )

                # ИСПРАВЛЕНО: ключ мог быть помечен невалидным ПРЯМО СЕЙЧАС,
                # внутри только что отработавшего get_order_from_exchange
                # (например поймали 700007) — перепроверяем и, если так,
                # отклоняем сразу с понятным текстом вместо сохранения
                # заведомо мёртвого ордера.
                request.user.refresh_from_db(fields=["mexc_key_valid", "bybit_key_valid"])
                if exchange_name == "MEXC" and not request.user.mexc_key_valid:
                    return Response({
                        "success": False,
                        "message": "Неправильно настроены API ключи MEXC (нет права "
                                   "P2P или ключ недействителен). Включите галочку "
                                   "'P2P' в настройках ключа на MEXC и обновите ключ "
                                   "в настройках системы."
                    }, status=403)
                if exchange_name == "Bybit" and not request.user.bybit_key_valid:
                    return Response({
                        "success": False,
                        "message": "Неправильно настроены API ключи Bybit. Обновите "
                                   "ключ в настройках системы."
                    }, status=403)

    if op_type not in ("SELL", "BUY"):
        op_type = "BUY"

    with transaction.atomic():
        try:
            o = Order.objects.select_for_update().get(
                user=request.user,
                external_id=external_id,
                exchange_type=exchange_name,
            )
            created = False
        except Order.DoesNotExist:
            o = Order.objects.create(
                user=request.user,
                external_id=external_id,
                exchange_type=exchange_name,
                operation_type=op_type,
            )
            created = True

        o.operation_type  = op_type
        o.commission      = commission
        o.commission_type = commission_type
        o.bank_detail     = bank
        o.price           = price
        o.cost            = cost
        o.amount          = amount
        o.is_verified     = is_verified
        o.is_manual       = is_manual
        if currency:
            o.currency = currency

        if receipt_dict and not (o.receipt and o.receipt.get("uuid")):
            o.receipt = receipt_dict

        if created:
            ex_lower = exchange_name.lower()
            user_comm_rate = 0.0
            if "bybit" in ex_lower:
                user_comm_rate = request.user.bybit_commission
            elif "htx" in ex_lower or "huobi" in ex_lower:
                user_comm_rate = request.user.htx_commission
            elif "mexc" in ex_lower:
                user_comm_rate = request.user.mexc_commission
            elif "bitget" in ex_lower:
                user_comm_rate = request.user.bitget_commission
            elif "telegram" in ex_lower:
                user_comm_rate = request.user.telegram_commission
            elif "gate" in ex_lower:
                user_comm_rate = getattr(request.user, "gate_commission", 0.0)
            o.exchange_commission_rate = user_comm_rate

        if created_at:
            o.created_at = created_at
        if "screenshotName" in data:
            o.screenshot_name = data.get("screenshotName")

        o.save()

    # ── Отправка чека ─────────────────────────────────────────────────────────
    receipt_debug = None

    if not is_verified:
        from .tasks import verify_and_receipt_later
        countdown = 120 if exchange_name == "MEXC" else 30
        verify_and_receipt_later.apply_async(
            args=[o.id],
            countdown=countdown,
            queue="receipt",
        )
        logger.info(
            "Order %s [%s]: чек отложен на %d сек.",
            external_id, exchange_name, countdown,
        )
    else:
        # Данные верифицированы — бьём чек сразу
        UnprocessedOrder.objects.filter(user=request.user, order_id=external_id).delete()

        if should_make_receipt(data):
            contact = receipt_dict.get("contact")
            if contact and cost:
                # ── ИСПРАВЛЕНИЕ ──────────────────────────────────────────────
                # Берём финансовые данные из верифицированного ордера (API),
                # а не из плашки расширения где курс мог прийти в копейках.
                # contact берём из receipt_dict — его в API нет.
                verified_receipt = {
                    **receipt_dict,
                    "price":  float(o.price),
                    "sum":    float(o.cost),
                    "amount": float(o.amount),
                }
                logger.info(
                    "Order %s [%s]: бьём чек с данными из ордера — price=%s sum=%s amount=%s",
                    external_id, exchange_name, float(o.price), float(o.cost), float(o.amount),
                )
                receipt_debug = create_or_update_and_send_receipt(o, verified_receipt)

    return Response({
        "success": True,
        "id": o.id,
        "verified": is_verified,
        "manual": is_manual,
        "receipt": {
            "enabled": bool(receipt_debug),
            "status": getattr(receipt_debug, "status", None),
            "error": getattr(receipt_debug, "error_text", None),
            "evotorUuid": getattr(receipt_debug, "evotor_uuid", None),
        } if receipt_debug else {"enabled": False}
    })

@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def order_delete(request, order_id: str):
    exchange_name = get_exchange_name(request.query_params.get("exchangeType", 1))
    o = Order.objects.filter(
        user=request.user,
        external_id=str(order_id),
        exchange_type=exchange_name,
    ).first()
    if not o:
        return Response({"message": "not found"}, status=404)
    if o.screenshot:
        o.screenshot.delete(save=False)
    o.delete()
    return Response({"success": True})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def order_my(request):
    qs = Order.objects.filter(user=request.user).order_by("-id")[:500]
    out = []
    for o in qs:
        out.append({
            "id": o.id,
            "orderId": o.external_id,
            "exchangeType": get_exchange_id(o.exchange_type),
            "type": o.operation_type,
            "commission": str(getattr(o, "commission", 0)),
            "commissionType": getattr(o, "commission_type", "PERCENT"),
            "createdAt": o.created_at.isoformat() if getattr(o, "created_at", None) else None,
            "details": {"name": o.bank_detail.name} if getattr(o, "bank_detail", None) else None,
            "price": str(getattr(o, "price", 0)),
            "amount": str(getattr(o, "cost", 0)),
            "quantity": str(getattr(o, "amount", 0)),
        })
    return Response(out)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def order_by_string_id(request):
    string_id     = (request.query_params.get("stringOrderId") or "").strip()
    exchange_name = get_exchange_name(request.query_params.get("exchangeType", 3))
    o = Order.objects.filter(user=request.user, external_id=str(string_id), exchange_type=exchange_name).first()
    if not o:
        return Response({"message": "not found"}, status=404)
    receipt_data = None
    if o.receipt and isinstance(o.receipt, dict) and o.receipt.get("uuid"):
        receipt_data = o.receipt
    return Response({
        "id": o.id,
        "orderId": o.external_id,
        "exchangeType": get_exchange_id(o.exchange_type),
        "type": o.operation_type,
        "commission": str(getattr(o, "commission", 0)),
        "commissionType": getattr(o, "commission_type", "PERCENT"),
        "receipt": receipt_data
    })


# ---------- SCREENSHOT ----------
@api_view(["POST", "GET"])
@permission_classes([IsAuthenticated])
def order_screenshot(request):
    if request.method == "POST":
        file = request.FILES.get("file")
        name = (request.data.get("name") or "").strip()
        if not file or not name:
            return Response({"message": "file and name required"}, status=400)
        order_key = name.rsplit(".", 1)[0]
        o = Order.objects.filter(user=request.user, external_id=order_key).order_by("-id").first()
        if not o:
            return Response({"message": "Order not found"}, status=404)
        if not hasattr(o, "screenshot"):
            return Response({"message": "No screenshot field"}, status=500)
        file.name = f"{order_key}.png"
        if o.screenshot:
            o.screenshot.delete(save=False)
        o.screenshot = file
        o.save()
        return Response({"success": True, "name": file.name})

    if request.method == "GET":
        name = (request.query_params.get("name") or "").strip()
        if not name:
            return Response({"message": "name required"}, status=400)
        order_key = name.rsplit(".", 1)[0]
        o = Order.objects.filter(user=request.user, external_id=order_key).order_by("-id").first()
        if not o or not getattr(o, "screenshot", None):
            raise Http404("not found")
        try:
            return FileResponse(o.screenshot.open("rb"), content_type="image/png")
        except FileNotFoundError:
            raise Http404("Файл на диске не найден")