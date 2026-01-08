from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from .services import sync_bybit_orders
from rest_framework.decorators import api_view, permission_classes, parser_classes, authentication_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from django.contrib.auth import authenticate
from rest_framework.authtoken.models import Token
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from django.db import transaction
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.forms import AuthenticationForm
from django.shortcuts import render, redirect
from django.contrib.auth.decorators import login_required

from .models import Order, BankDetail, UnprocessedOrder, User

from django.views.decorators.csrf import csrf_exempt


from django.contrib.auth.hashers import make_password
from django.utils import timezone
from .models import Order, BankDetail # ОБЯЗАТЕЛЬНО добавь импорт BankDetail
import datetime

from django.http import JsonResponse, HttpResponse
from .models import Order, User # Предположим, модель называется Order
import json



#ПОЛЬЗАК ПАНЕЛЬ

@login_required
def my_orders_list(request):
    default_banks = ['Тинькофф', 'Сбербанк', 'Альфа-Банк', 'ВТБ']
    
    # ЛОГИКА СОЗДАНИЯ
    if request.method == 'POST' and 'create_order' in request.POST:
        raw_date = request.POST.get('created_at')
        order_date = datetime.datetime.strptime(raw_date, '%Y-%m-%dT%H:%M') if raw_date else timezone.now()

        # 1. Получаем название банка из формы
        bank_name = request.POST.get('details') 
        
        # 2. Ищем этот банк в базе данных пользователя или создаем новый, если его нет
        # Это превращает строку "Сбербанк" в объект, который понимает база данных
        bank_instance, created = BankDetail.objects.get_or_create(
            user=request.user,
            name=bank_name
        )

        # 3. Теперь создаем ордер, передавая готовый объект банка
        Order.objects.create(
            user=request.user,
            external_id=request.POST.get('external_id'),
            price=request.POST.get('price') or 0,
            amount=request.POST.get('amount') or 0,
            cost=request.POST.get('cost') or 0,
            operation_type=request.POST.get('operation_type'),
            exchange_type=request.POST.get('exchange'),
            
            # ВАЖНО: передаем объект, а не строку
            bank_detail=bank_instance, 
            
            commission=request.POST.get('commission_value') or 0,
            commission_type=request.POST.get('commission_type'),
            created_at=order_date
        )
        return redirect('my_orders')

    orders = Order.objects.filter(user=request.user).order_by('-created_at')
    current_time = timezone.now().strftime('%Y-%m-%dT%H:%M')
    
    return render(request, 'orders/my_orders.html', {
        'orders': orders,
        'default_banks': default_banks,
        'current_time': current_time
    })



@login_required
def edit_order(request, order_id):
    order = get_object_or_404(Order, id=order_id, user=request.user)
    
    if request.method == 'POST':
        # 1. Получаем название банка из формы (например, "ВТБ")
        bank_name = request.POST.get('details')
        
        # 2. Находим или создаем объект BankDetail для этого пользователя
        bank_instance, created = BankDetail.objects.get_or_create(
            user=request.user,
            name=bank_name
        )

        # 3. Обновляем поля ордера
        order.external_id = request.POST.get('external_id')
        order.price = request.POST.get('price') or 0
        order.amount = request.POST.get('amount') or 0
        order.cost = request.POST.get('cost') or 0
        order.operation_type = request.POST.get('operation_type')
        order.exchange_type = request.POST.get('exchange')
        
        # ВАЖНО: Присваиваем объект bank_instance, а не строку bank_name
        order.bank_detail = bank_instance 
        
        order.commission = request.POST.get('commission_value') or 0
        order.commission_type = request.POST.get('commission_type')
        
        # Обработка даты
        raw_date = request.POST.get('created_at')
        if raw_date:
            order.created_at = datetime.datetime.strptime(raw_date, '%Y-%m-%dT%H:%M')

        order.save()
        return redirect('my_orders')
    

@login_required
def delete_order(request, order_id):
    order = get_object_or_404(Order, id=order_id, user=request.user)
    order.delete()
    return redirect('my_orders')

@login_required
def upload_screenshot(request, order_id):
    if request.method == 'POST' and request.FILES.get('screenshot'):
        order = get_object_or_404(Order, id=order_id, user=request.user)
        order.screenshot = request.FILES.get('screenshot')
        order.save()
    return redirect('my_orders')



@login_required
def profile_settings(request):
    user = request.user
    if request.method == 'POST':
        # Онлайн-касса
        user.evotor_login = request.POST.get('evotor_login')
        user.evotor_password = request.POST.get('evotor_password')
        user.kkt_id = request.POST.get('kkt_id')
        user.email = request.POST.get('email')
        user.payment_address = request.POST.get('payment_address')
        user.tax_type = request.POST.get('tax_type') # Новый параметр
        user.inn = request.POST.get('inn')           # Новый параметр
        
        # API Ключи
        user.htx_access_key = request.POST.get('htx_key')
        user.htx_private_key = request.POST.get('htx_secret')
        user.mexc_api_key = request.POST.get('mexc_key')      # Добавлено
        user.mexc_api_secret = request.POST.get('mexc_secret') # Добавлено
        user.bybit_api_key = request.POST.get('bybit_key')
        user.bybit_api_secret = request.POST.get('bybit_secret')
        
        user.save()
        return redirect('settings')
        
    return render(request, 'orders/settings.html')


@login_required
def unprocessed_orders_list(request):
    # Синхронизация при заходе на страницу
    sync_bybit_orders(request.user)
    
    # Получаем список для текущего юзера
    unprocessed_orders = UnprocessedOrder.objects.filter(user=request.user).order_by('-created_at')
    
    return render(request, 'orders/unprocessed.html', {
        'unprocessed_orders': unprocessed_orders
    })






#АДМИН ПАНЕЛЬ

@login_required
def admin_users_list(request):
    # 1. Проверка на админа
    if not request.user.is_superuser:
        return redirect('my_orders')
    
    if request.method == 'POST' and request.POST.get('action') == 'edit_user':
        user_id = request.POST.get('user_id')
        user_to_edit = User.objects.get(id=user_id)
        
        user_to_edit.bybit_api_key = request.POST.get('bybit_key')
        user_to_edit.bybit_api_secret = request.POST.get('bybit_secret')
        user_to_edit.htx_access_key = request.POST.get('htx_key')
        user_to_edit.htx_private_key = request.POST.get('htx_secret')
        user_to_edit.evotor_login = request.POST.get('evotor_login')
        user_to_edit.evotor_password = request.POST.get('evotor_password')

        user_to_edit.save()
        return redirect('admin_users')
    

    # 2. Обработка создания пользователя (POST)
    if request.method == 'POST' and request.POST.get('action') == 'create_user':
        username = request.POST.get('username')
        password = request.POST.get('password')
        
        if username and password:
            User.objects.create(
                username=username,
                password=make_password(password),
                bybit_api_key=request.POST.get('bybit_key'),
                bybit_api_secret=request.POST.get('bybit_secret'),
                is_staff=True # Чтобы мог зайти в систему если нужно
            )
        return redirect('admin_users') # После создания всегда редирект!

    # 3. Логика получения списка пользователей (GET)
    users = User.objects.all().order_by('id')
    user_list = []

    for user in users:
        user_list.append({
            'id': user.id,
            'login': user.username,
            'bybit': bool(user.bybit_api_key and user.bybit_api_secret),
            'htx': bool(user.htx_access_key and user.htx_private_key),
            'mexc': False, # Заглушка, если нет в модели
            'evotor': bool(user.evotor_login and user.evotor_password),
        })

    # 4. САМОЕ ВАЖНОЕ: Этот return должен быть в самом конце функции
    # Если его нет или он "залез" внутрь if, будет ошибка "returned None"
    return render(request, 'admin/users_list.html', {'users': users})



def admin_login(request):
    if request.user.is_authenticated and request.user.is_superuser:
        return redirect('admin_users')
    
    if request.method == 'POST':
        form = AuthenticationForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            if user.is_superuser:
                login(request, user)
                return redirect('admin_users')
    
    return render(request, 'admin/login.html')


@login_required(login_url='admin_login')
def admin_logout(request):
    logout(request)
    return redirect('admin_login')



@login_required(login_url='admin_login')
def admin_orders_editor(request):
    if not request.user.is_superuser:
        return redirect('my_orders')

    order = None
    search_id = request.GET.get('order_id_search')
    
    # 1. ПОИСК ЗАКАЗА (используем external_id, как в твоей модели)
    if search_id:
        order = Order.objects.filter(external_id=search_id).first()

    # 2. СОХРАНЕНИЕ ИЗМЕНЕНИЙ
    if request.method == 'POST' and 'save_order' in request.POST:
        target_id = request.POST.get('target_order_pk')
        current_order = Order.objects.get(pk=target_id)
        
        # Обновляем поля согласно твоему списку
        current_order.operation_type = request.POST.get('type') # operation_type вместо type
        current_order.price = request.POST.get('price')
        current_order.amount = request.POST.get('amount')
        current_order.cost = request.POST.get('quantity') # Вероятно, quantity у тебя это cost
        current_order.commission = request.POST.get('commission')
        current_order.commission_type = request.POST.get('commission_type')
        current_order.exchange_type = request.POST.get('exchange_type')
        
        date_raw = request.POST.get('created_at')
        if date_raw:
            current_order.created_at = date_raw
            
        current_order.save()
        return redirect(f'/p2p-admin/orders/?order_id_search={current_order.external_id}')

    return render(request, 'admin/orders_editor.html', {'order': order})

@login_required
def admin_turnover_control(request):
    if not request.user.is_superuser: return redirect('my_orders')
    return render(request, 'admin/turnover_control.html')

@login_required
def admin_statistics(request):
    if not request.user.is_superuser: return redirect('my_orders')
    return render(request, 'admin/statistics.html')