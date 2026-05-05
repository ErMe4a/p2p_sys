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
        qs = BankDetail.objects.filter(is_deleted=False).order_by("id")
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
            "receipt": receipt_data
        })

    # === POST ===
    data = request.data

    external_id = str(data.get("orderId") or data.get("stringOrderId") or "").strip()
    if not external_id:
        return Response({"message": "orderId required"}, status=400)

    exchange_name = get_exchange_name(data.get("exchangeType", 1))

    # ── Проверка валидности ключей биржи ─────────────────────────────────────
    if exchange_name == "Bybit" and not request.user.bybit_key_valid:
        return Response({
            "success": False,
            "message": "Ключ Bybit API недействителен или истёк. Обновите ключ в настройках."
        }, status=403)

    if exchange_name == "MEXC" and not request.user.mexc_key_valid:
        return Response({
            "success": False,
            "message": "Ключ MEXC API недействителен. Обновите ключ в настройках."
        }, status=403)

    commission      = data.get("commission") or 0
    commission_type = data.get("commissionType", "PERCENT")

    # ── Флаг ручного редактирования ──────────────────────────────────────────
    is_manual = bool(data.get("manualEdit", False))

    created_at = None
    if "createdAt" in data:
        created_at = parse_datetime(data.get("createdAt"))

    # Банк
    bank = None
    details_obj = data.get("details")
    if isinstance(details_obj, dict):
        bank_id = details_obj.get("id")
        if bank_id:
            bank = BankDetail.objects.filter(id=bank_id, is_deleted=False).first()
    elif isinstance(details_obj, int):
        bank = BankDetail.objects.filter(id=details_obj, is_deleted=False).first()

    # Данные чека из расширения (contact, sum и тд)
    receipt_data_raw = data.get("receipt")
    receipt_dict = receipt_data_raw if isinstance(receipt_data_raw, dict) else {}

    # ── Получаем финансовые данные ────────────────────────────────────────────
    if is_manual:
        # Пользователь отредактировал данные вручную — берём из плашки, API не трогаем
        price       = data.get("price") or receipt_dict.get("price") or 0
        cost        = data.get("amount") or receipt_dict.get("sum") or 0
        amount      = data.get("quantity") or receipt_dict.get("amount") or 0
        op_type     = str(data.get("type") or "BUY").strip().upper()
        is_verified = True  # данные финальные, чек бьём сразу без Celery
        logger.info(
            "Order %s [%s]: ручное редактирование — price=%s cost=%s amount=%s type=%s",
            external_id, exchange_name, price, cost, amount, op_type,
        )
    else:
        # Стандартный путь — тянем данные из API биржи
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

    if op_type not in ("SELL", "BUY"):
        op_type = "BUY"

    # ── Сохранение ────────────────────────────────────────────────────────────
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
        o.is_manual       = is_manual  # <- новое поле

        # Сохраняем данные чека (contact, sum и тд) для verify_and_receipt_later
        if receipt_dict and not (o.receipt and o.receipt.get("uuid")):
            o.receipt = receipt_dict

        # Фиксируем процент биржи только при создании
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
        # Bybit/MEXC — данных из API нет, откладываем в Celery
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
        # Данные верифицированы (API или ручной режим) — бьём чек сразу
        UnprocessedOrder.objects.filter(user=request.user, order_id=external_id).delete()

        if should_make_receipt(data):
            contact = receipt_dict.get("contact")
            if contact and cost:
                receipt_debug = create_or_update_and_send_receipt(o, receipt_dict)

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