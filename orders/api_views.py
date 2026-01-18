from django.contrib.auth import authenticate
from django.http import FileResponse, Http404
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from rest_framework.authtoken.models import Token

from .models import BankDetail, Order

# --- ВСПОМОГАТЕЛЬНЫЕ КАРТЫ ДЛЯ ТЕКСТОВОГО ПОЛЯ EXCHANGE_TYPE ---

# Из ID расширения -> в строку для вашей БД
EXCHANGE_ID_TO_NAME = {
    1: "Bybit",
    2: "HTX",
    3: "MEXC"
}

# Из строки БД -> в ID для расширения
EXCHANGE_NAME_TO_ID = {
    "Bybit": 1,
    "BYBIT": 1,
    "HTX": 2,
    "MEXC": 3
}

def get_exchange_id(name):
    """Превращает 'Bybit' в 1"""
    return EXCHANGE_NAME_TO_ID.get(str(name), 1)

def get_exchange_name(id_input):
    """Превращает 1 в 'Bybit'"""
    try:
        n = int(id_input)
        return EXCHANGE_ID_TO_NAME.get(n, "Bybit")
    except:
        return "Bybit"

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

    # Упрощенный маппинг для PUT
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
        qs = BankDetail.objects.filter(user=request.user, is_deleted=False).order_by("id")
        return Response([{"id": d.id, "name": d.name} for d in qs])

    name = (request.data.get("name") or "").strip()
    if not name:
        return Response({"message": "name is required"}, status=400)

    d = BankDetail.objects.create(user=request.user, name=name)
    return Response({"id": d.id, "name": d.name})


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
def details_delete(request, pk: int):
    d = BankDetail.objects.filter(pk=pk, user=request.user).first()
    if not d:
        return Response({"message": "not found"}, status=404)
    d.is_deleted = True
    d.save()
    return Response({"success": True})


# ---------- ORDER ----------
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def order(request):
    """
    GET  /api/order?id=...&exchangeType=1
    POST /api/order (save/update)
    """
    # === GET: Поиск конкретного ордера ===
    if request.method == "GET":
        order_id = (request.query_params.get("id") or "").strip()
        # Переводим число из запроса в имя для поиска в БД
        exchange_name = get_exchange_name(request.query_params.get("exchangeType", 1))

        if not order_id:
            return Response({"message": "id is required"}, status=400)

        o = Order.objects.filter(
            user=request.user,
            external_id=str(order_id),
            exchange_type=exchange_name,
        ).first()

        if not o:
            return Response({"message": "not found"}, status=404)

        return Response({
            "id": o.id,
            "orderId": o.external_id,
            "exchangeType": get_exchange_id(o.exchange_type), # Возвращаем число 1, 2 или 3
            "type": o.operation_type,
            "commission": str(getattr(o, "commission", 0)),
            "commissionType": getattr(o, "commission_type", "PERCENT"),
            "details": {"id": o.bank_detail_id} if getattr(o, "bank_detail_id", None) else None,
            "createdAt": o.created_at.isoformat() if getattr(o, "created_at", None) else None,
            "price": str(getattr(o, "price", 0)),
            "amount": str(getattr(o, "cost", 0)),     # Фиат
            "quantity": str(getattr(o, "amount", 0)), # Крипта
        })

    # === POST: Сохранение ордера ===
    data = request.data
    
    external_id = str(data.get("orderId") or data.get("stringOrderId") or "").strip()
    if not external_id:
        return Response({"message": "orderId required"}, status=400)

    # Переводим число из расширения в слово для вашей модели
    exchange_name = get_exchange_name(data.get("exchangeType", 1))
    
    op_type = data.get("type", "BUY")
    commission = data.get("commission") or 0
    commission_type = data.get("commissionType", "PERCENT") 
    
    created_at = None
    if "createdAt" in data:
        created_at = parse_datetime(data.get("createdAt"))

    # Обработка банка
    bank = None
    details_obj = data.get("details")
    if isinstance(details_obj, dict):
        bank_id = details_obj.get("id")
        if bank_id:
            bank = BankDetail.objects.filter(id=bank_id, user=request.user, is_deleted=False).first()

    # --- ИЗВЛЕЧЕНИЕ ДАННЫХ ИЗ RECEIPT ---
    price = data.get("price")
    quantity = data.get("quantity") # Крипта
    cost = data.get("amount")       # Фиат

    receipt_data = data.get("receipt")
    if isinstance(receipt_data, dict):
        if not price: price = receipt_data.get("price")
        if not quantity: quantity = receipt_data.get("amount")
        if not cost: cost = receipt_data.get("sum")

    # Сохранение (update_or_create)
    o, created = Order.objects.update_or_create(
        user=request.user,
        external_id=external_id,
        exchange_type=exchange_name, # Запишется "Bybit", "HTX" или "MEXC"
        defaults={
            "operation_type": op_type
        },
    )

    # Принудительно обновляем поля
    o.operation_type = op_type
    o.commission = commission
    o.commission_type = commission_type
    o.bank_detail = bank
    
    if created_at: o.created_at = created_at
    if "screenshotName" in data: o.screenshot_name = data.get("screenshotName")

    # Сохраняем цифры
    if price: o.price = price
    if cost: o.cost = cost
    if quantity: o.amount = quantity

    o.save()
    
    return Response({"success": True, "id": o.id})


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
    o.delete()
    return Response({"success": True})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def order_my(request):
    """Список для таблицы в расширении"""
    qs = Order.objects.filter(user=request.user).order_by("-id")[:500]
    out = []
    for o in qs:
        out.append({
            "id": o.id,
            "orderId": o.external_id,
            "exchangeType": get_exchange_id(o.exchange_type), # Обратно в число для фронта
            "type": o.operation_type,
            "commission": str(getattr(o, "commission", 0)),
            "commissionType": getattr(o, "commission_type", "PERCENT"),
            "createdAt": o.created_at.isoformat() if getattr(o, "created_at", None) else None,
            "details": {"name": o.bank_detail.name} if getattr(o, "bank_detail", None) else None,
            "price": str(getattr(o, "price", 0)),
            "amount": str(getattr(o, "cost", 0)),     # Сумма
            "quantity": str(getattr(o, "amount", 0)), # Крипта
        })
    return Response(out)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def order_by_string_id(request):
    string_id = (request.query_params.get("stringOrderId") or "").strip()
    exchange_name = get_exchange_name(request.query_params.get("exchangeType", 3))

    o = Order.objects.filter(
        user=request.user,
        external_id=str(string_id),
        exchange_type=exchange_name,
    ).first()

    if not o: return Response({"message": "not found"}, status=404)

    return Response({
        "id": o.id,
        "orderId": o.external_id,
        "exchangeType": get_exchange_id(o.exchange_type),
        "type": o.operation_type,
        "commission": str(getattr(o, "commission", 0)),
        "commissionType": getattr(o, "commission_type", "PERCENT"),
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
        
        if not o: return Response({"message": "Order not found"}, status=404)
        if not hasattr(o, "screenshot"): return Response({"message": "No screenshot field"}, status=500)

        o.screenshot = file
        o.save()
        return Response({"success": True, "name": name})

    # GET
    name = (request.query_params.get("name") or "").strip()
    if not name: return Response({"message": "name required"}, status=400)
    order_key = name.rsplit(".", 1)[0]
    o = Order.objects.filter(user=request.user, external_id=order_key).order_by("-id").first()
    if not o or not getattr(o, "screenshot", None): raise Http404("not found")

    return FileResponse(o.screenshot.open("rb"), content_type="image/png")