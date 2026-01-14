from django.contrib.auth import authenticate
from django.http import FileResponse, Http404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from rest_framework.authtoken.models import Token

from .models import BankDetail, Order

EXCHANGE_MAP = {1: "BYBIT", 2: "HTX", 3: "MEXC"}

def normalize_exchange(exchange_type):
    try:
        n = int(exchange_type)
        return EXCHANGE_MAP.get(n, "BYBIT")
    except Exception:
        return "BYBIT"

# ---------- AUTH ----------
@api_view(["POST"])
@permission_classes([AllowAny])
def auth_login(request):
    login = request.data.get("login")
    password = request.data.get("password")

    user = authenticate(username=login, password=password)
    if not user:
        return Response({"message": "Неверный логин или пароль"}, status=status.HTTP_401_UNAUTHORIZED)

    token, _ = Token.objects.get_or_create(user=user)
    # расширение ждёт token / tokenType
    return Response({
        "token": token.key,
        "tokenType": "Token",
        "userId": user.id,
        "login": user.username,
    })


# ---------- USER ----------
@api_view(["GET", "PUT"])
def users_me(request):
    u = request.user

    if request.method == "GET":
        return Response({
            "id": u.id,
            "login": u.username,                 # ВАЖНО
            "inn": getattr(u, "inn", "") or "",
            "kktId": getattr(u, "kkt_id", "") or "",
            "paymentAddress": getattr(u, "payment_address", "") or "",
            "taxType": getattr(u, "tax_type", "") or "",

            # ВАЖНО: camelCase под расширение
            "evotorLogin": getattr(u, "evotor_login", "") or "",
            "evotorPassword": getattr(u, "evotor_password", "") or "",
        })

    # PUT — поддержи и camelCase и snake_case
    mapping = {
        "inn": "inn",
        "kktId": "kkt_id",
        "paymentAddress": "payment_address",
        "taxType": "tax_type",
        "evotorLogin": "evotor_login",
        "evotorPassword": "evotor_password",
        # на всякий: если вдруг где-то шлют snake_case
        "kkt_id": "kkt_id",
        "payment_address": "payment_address",
        "tax_type": "tax_type",
        "evotor_login": "evotor_login",
        "evotor_password": "evotor_password",
    }

    for k, field in mapping.items():
        if k in request.data:
            setattr(u, field, request.data.get(k))

    u.save()
    return Response({"success": True})



# ---------- DETAILS ----------
@api_view(["GET", "POST"])
def details(request):
    if request.method == "GET":
        qs = BankDetail.objects.filter(user=request.user, is_deleted=False).order_by("id")
        return Response([{"id": d.id, "name": d.name} for d in qs])

    name = (request.data.get("name") or "").strip()
    if not name:
        return Response({"message": "name is required"}, status=400)

    d = BankDetail.objects.create(user=request.user, name=name)
    return Response({"id": d.id, "name": d.name})


@api_view(["DELETE"])
def details_delete(request, pk: int):
    d = BankDetail.objects.filter(pk=pk, user=request.user).first()
    if not d:
        return Response({"message": "not found"}, status=404)
    d.is_deleted = True
    d.save()
    return Response({"success": True})


# ---------- ORDER ----------
@api_view(["GET", "POST"])
def order(request):
    """
    GET  /api/order?id=...&exchangeType=1|2|3
    POST /api/order   (body содержит orderId/stringOrderId и т.д.)
    """
    if request.method == "GET":
        order_id = (request.query_params.get("id") or "").strip()
        exchange_type = normalize_exchange(request.query_params.get("exchangeType", 1))

        if not order_id:
            return Response({"message": "id is required"}, status=400)

        o = Order.objects.filter(
            user=request.user,
            external_id=str(order_id),
            exchange_type=exchange_type,
        ).first()

        if not o:
            return Response({"message": "not found"}, status=404)

        return Response({
            "id": o.id,
            "orderId": o.external_id,
            "exchangeType": o.exchange_type,
            "type": o.operation_type,
            "commission": str(getattr(o, "commission", 0)),
            "commissionType": getattr(o, "commission_type", "PERCENT"),
            "details": {"id": o.bank_detail_id} if getattr(o, "bank_detail_id", None) else None,
            "receipt": getattr(o, "receipt", None),
        })

    # POST (save/update)
    data = request.data

    external_id = str(data.get("orderId") or data.get("stringOrderId") or "").strip()
    if not external_id:
        return Response({"message": "orderId/stringOrderId is required"}, status=400)

    exchange_type = normalize_exchange(data.get("exchangeType", 1))
    op_type = data.get("type", "BUY")
    commission = data.get("commission") or 0
    commission_type = data.get("commissionType", "PERCENT")

    bank = None
    details_obj = data.get("details")
    if isinstance(details_obj, dict):
        bank_id = details_obj.get("id")
        if bank_id:
            bank = BankDetail.objects.filter(id=bank_id, user=request.user, is_deleted=False).first()

    o, _ = Order.objects.get_or_create(
        user=request.user,
        external_id=external_id,
        exchange_type=exchange_type,
        defaults={"operation_type": op_type},
    )

    o.operation_type = op_type
    if hasattr(o, "commission"):
        o.commission = commission
    if hasattr(o, "commission_type"):
        o.commission_type = commission_type
    if hasattr(o, "bank_detail"):
        o.bank_detail = bank

    # MEXC/прочее может прислать эти поля — ставим если существуют
    if hasattr(o, "price") and "price" in data:
        o.price = data.get("price") or 0
    if hasattr(o, "cost") and "amount" in data:
        o.cost = data.get("amount") or 0
    if hasattr(o, "amount") and "quantity" in data:
        o.amount = data.get("quantity") or 0

    if hasattr(o, "receipt") and "receipt" in data:
        o.receipt = data.get("receipt")

    o.save()
    # расширение ожидает просто число id (в коде оно так обрабатывается)
    return Response(o.id)


@api_view(["DELETE"])
def order_delete(request, order_id: str):
    """
    DELETE /api/order/<orderId>?exchangeType=...
    """
    exchange_type = normalize_exchange(request.query_params.get("exchangeType", 1))
    o = Order.objects.filter(
        user=request.user,
        external_id=str(order_id),
        exchange_type=exchange_type,
    ).first()
    if not o:
        return Response({"message": "not found"}, status=404)
    o.delete()
    return Response({"success": True})


@api_view(["GET"])
def order_my(request):
    """
    GET /api/order/my
    """
    qs = Order.objects.filter(user=request.user).order_by("-id")[:500]
    out = []
    for o in qs:
        out.append({
            "id": o.id,
            "orderId": o.external_id,
            "exchangeType": o.exchange_type,
            "type": o.operation_type,
            "receipt": getattr(o, "receipt", None),
        })
    return Response(out)


@api_view(["GET"])
def order_by_string_id(request):
    """
    GET /api/order/by-string-id?stringOrderId=...&exchangeType=3
    (расширение использует это для MEXC)
    """
    string_id = (request.query_params.get("stringOrderId") or "").strip()
    exchange_type = normalize_exchange(request.query_params.get("exchangeType", 3))

    if not string_id:
        return Response({"message": "stringOrderId is required"}, status=400)

    o = Order.objects.filter(
        user=request.user,
        external_id=str(string_id),
        exchange_type=exchange_type,
    ).first()

    if not o:
        return Response({"message": "not found"}, status=404)

    return Response({
        "id": o.id,
        "orderId": o.external_id,
        "exchangeType": o.exchange_type,
        "type": o.operation_type,
        "receipt": getattr(o, "receipt", None),
    })


# ---------- SCREENSHOT ----------
@api_view(["POST", "GET"])
def order_screenshot(request):
    """
    POST /api/order/screenshot  multipart: file, name (пример: 12345.png)
    GET  /api/order/screenshot?name=12345.png
    """
    if request.method == "POST":
        file = request.FILES.get("file")
        name = (request.data.get("name") or "").strip()

        if not file or not name:
            return Response({"message": "file and name required"}, status=400)

        order_key = name.rsplit(".", 1)[0]
        o = Order.objects.filter(user=request.user, external_id=order_key).order_by("-id").first()
        if not o:
            return Response({"message": "order not found for screenshot"}, status=404)

        if not hasattr(o, "screenshot"):
            return Response({"message": "Order model has no screenshot field"}, status=500)

        o.screenshot = file
        o.save()
        return Response({"success": True, "name": name})

    # GET
    name = (request.query_params.get("name") or "").strip()
    if not name:
        return Response({"message": "name required"}, status=400)

    order_key = name.rsplit(".", 1)[0]
    o = Order.objects.filter(user=request.user, external_id=order_key).order_by("-id").first()

    if not o or not getattr(o, "screenshot", None):
        raise Http404("not found")

    # content_type можно не угадывать идеально — но пусть будет png
    return FileResponse(o.screenshot.open("rb"), content_type="image/png")
