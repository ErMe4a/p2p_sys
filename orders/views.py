from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
# from .services import sync_bybit_orders

from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.forms import AuthenticationForm
from django.shortcuts import render, redirect
from django.contrib.auth.decorators import login_required
from .models import Order, BankDetail, UnprocessedOrder, User
from django.contrib import messages
from django.contrib.auth.hashers import make_password
from django.utils import timezone
from .models import Order, BankDetail 
import datetime
from django.http import JsonResponse, HttpResponse
from .models import Order, User 
from django.contrib.auth import get_user_model
from django.shortcuts import render, redirect
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.db.models import Sum, Q
from django.contrib.auth.models import User  # Или твоя модель пользователя
from .models import Order # Убедись, что импорт правильный


from django.db.models import Sum, Q
from django.contrib.auth.decorators import user_passes_test

from django.shortcuts import render, redirect
from django.contrib.auth.decorators import login_required, user_passes_test
from django.http import JsonResponse
from django.db.models import Sum, Q
from django.contrib.auth import get_user_model # <--- ВАЖНОЕ ИЗМЕНЕНИЕ
from .models import Order 
import openpyxl
from openpyxl.styles import Alignment, Font, Border, Side
from django.http import HttpResponse

from .bybit_api import sync_bybit_orders

User = get_user_model()

from django.core.paginator import Paginator
from django.contrib.auth import get_user_model
from django.db.models import Q
from .service_for_stat_24 import get_orders_parallel

from .receipt_service import create_or_update_and_send_receipt
from django.views.decorators.http import require_POST
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.contrib.auth.decorators import login_required

from .models import Order
from .receipt_service import create_or_update_and_send_receipt
#ПОЛЬЗАК ПАНЕЛЬ____________________________________________________________________________________________________________________




@login_required
@require_POST
def receipt_test_send(request, order_id: int):
    """
    ТЕСТ: пробить чек на существующий ордер
    - сумма всегда 1 рубль
    - назначение берём из формы (purpose), по умолчанию 'тестовый перевод'
    """
    o = get_object_or_404(Order, id=order_id, user=request.user)

    purpose = (request.POST.get("purpose") or "").strip() or "тестовый перевод"

    receipt_data = {
        "sum": "1",                 # принудительно 1 рубль
        "purpose": purpose,         # попадет в item_name
        "paymentMethod": "CARD",    # можешь заменить на CASH если нужно
        "customerContact": request.user.email or "",
    }

    r = create_or_update_and_send_receipt(o, receipt_data)

    return JsonResponse({
        "ok": (r.status in ("SENT", "DONE")),
        "status": r.status,
        "error": r.error_text or "",
        "evotorUuid": r.evotor_uuid or "",
    })

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

        order.external_id = request.POST.get('external_id')
        order.price = request.POST.get('price') or 0
        order.amount = request.POST.get('amount') or 0
        order.cost = request.POST.get('cost') or 0
        order.operation_type = request.POST.get('operation_type')
        order.exchange_type = request.POST.get('exchange')

        order.bank_detail = bank_instance 
        
        order.commission = request.POST.get('commission_value') or 0
        order.commission_type = request.POST.get('commission_type')
        

        raw_date = request.POST.get('created_at')
        if raw_date:
            order.created_at = datetime.datetime.strptime(raw_date, '%Y-%m-%dT%H:%M')

        order.save()
        return redirect('my_orders')
    

@login_required
def delete_order(request, order_id):
    order = get_object_or_404(Order, id=order_id, user=request.user)
    

    if order.screenshot:
        order.screenshot.delete(save=False)
        
    order.delete()
    return redirect('my_orders')

@login_required
def upload_screenshot(request, order_id):

    if request.method == 'POST' and request.FILES.get('screenshot'):
        order = get_object_or_404(Order, id=order_id, user=request.user)
        file = request.FILES.get('screenshot')

    
        order_key = str(order.external_id)
        file.name = f"{order_key}.png"


        if order.screenshot:
            order.screenshot.delete(save=False)


        order.screenshot = file
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
        user.inn = request.POST.get('inn')           
        
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
    """
    Страница необработанных ордеров.
    При загрузке автоматически синхронизируется с Bybit.
    """
    
    # 1. Запускаем синхронизацию
    # Функция сама проверит ключи и добавит новые ордера в БД
    sync_bybit_orders(request.user)
    
    # 2. Получаем список ордеров из базы
    # Сортируем: сначала новые (по дате создания)
    unprocessed_orders = UnprocessedOrder.objects.filter(
        user=request.user
    ).order_by('-created_at')
    
    # 3. Проверка ключей для отображения предупреждения (опционально)
    keys_configured = bool(request.user.bybit_api_key and request.user.bybit_api_secret)
    if not keys_configured:
        messages.warning(request, "API ключи Bybit не настроены. Синхронизация невозможна.")

    context = {
        'unprocessed_orders': unprocessed_orders,
        'keys_configured': keys_configured
    }
    
    return render(request, 'orders/unprocessed.html', context)





# --- АДМИН ПАНЕЛЬ ---

@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_users_list(request):
    """Список пользователей и управление ими"""
    # 1. Проверка на админа (дублирует декоратор, но для надежности можно оставить)
    if not request.user.is_superuser:
        return redirect('admin_login')
    
    # 2. Обработка редактирования пользователя
    if request.method == 'POST' and request.POST.get('action') == 'edit_user':
        user_id = request.POST.get('user_id')
        try:
            user_to_edit = User.objects.get(id=user_id)
            user_to_edit.bybit_api_key = request.POST.get('bybit_key')
            user_to_edit.bybit_api_secret = request.POST.get('bybit_secret')
            user_to_edit.htx_access_key = request.POST.get('htx_key')
            user_to_edit.htx_private_key = request.POST.get('htx_secret')
            user_to_edit.evotor_login = request.POST.get('evotor_login')
            user_to_edit.evotor_password = request.POST.get('evotor_password')
            user_to_edit.save()
            messages.success(request, f"Пользователь {user_to_edit.username} обновлен.")
        except User.DoesNotExist:
            messages.error(request, "Пользователь не найден.")
        return redirect('admin_users')

    # 3. Обработка создания пользователя
    if request.method == 'POST' and request.POST.get('action') == 'create_user':
        username = request.POST.get('username')
        password = request.POST.get('password')
        if username and password:
            User.objects.create(
                username=username,
                password=make_password(password),
                bybit_api_key=request.POST.get('bybit_key'),
                bybit_api_secret=request.POST.get('bybit_secret'),
                is_staff=True # Разрешаем вход в систему
            )
            messages.success(request, f"Пользователь {username} создан.")
        return redirect('admin_users')

    # 4. Вывод списка
    users = User.objects.all().order_by('id')
    return render(request, 'custom_admin/users_list.html', {'users': users})


@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def export_excel_report(request):
    """Экспорт отчета в Excel"""
    user_id = request.GET.get('user_id')
    start_date = request.GET.get('start')
    end_date = request.GET.get('end')
    bank_id = request.GET.get('bank_id')
    op_type = request.GET.get('type')

    orders = Order.objects.filter(user_id=user_id).order_by('created_at')

    if start_date: orders = orders.filter(created_at__date__gte=start_date)
    if end_date: orders = orders.filter(created_at__date__lte=end_date)
    if bank_id and bank_id.isdigit(): orders = orders.filter(bank_detail_id=bank_id)
    if op_type: orders = orders.filter(operation_type=op_type)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Отчет"

    thin_border = Border(left=Side(style='thin'), right=Side(style='thin'), top=Side(style='thin'), bottom=Side(style='thin'))
    bold_font = Font(bold=True)
    center_align = Alignment(horizontal='center', vertical='center', wrap_text=True)

    ws.merge_cells('A1:L1')
    ws['A1'] = "Учет приобретенной и проданной цифровой валюты (ЦВ)"
    ws['A1'].font = Font(size=14, bold=True)
    ws['A1'].alignment = Alignment(horizontal='center')

    ws.merge_cells('A2:A3'); ws['A2'] = "№ п/п"
    ws.merge_cells('B2:B3'); ws['B2'] = "Дата операции"
    ws.merge_cells('C2:C3'); ws['C2'] = "Номер документа"
    ws.merge_cells('D2:D3'); ws['D2'] = "Наименование ЦВ"
    ws.merge_cells('E2:H2'); ws['E2'] = "Приобретение цифровой валюты"
    ws.merge_cells('I2:L2'); ws['I2'] = "Продажа цифровой валюты"

    ws.append(["", "", "", "", "Кол-во", "Курс", "Стоимость", "Комиссия", "Кол-во", "Курс", "Стоимость", "Комиссия"])

    for idx, o in enumerate(orders, 1):
        b_data = [o.amount, o.price, o.cost, o.commission] if o.operation_type == 'BUY' else ["", "", "", ""]
        s_data = [o.amount, o.price, o.cost, o.commission] if o.operation_type == 'SELL' else ["", "", "", ""]
        
        # Пересчет комиссии (если нужно)
        comm_val = float(o.commission or 0)
        total_comm = (float(o.cost) * comm_val / 100) if o.commission_type == 'PERCENT' else comm_val
        
        # Обновляем ячейку с комиссией
        if o.operation_type == 'BUY': b_data[3] = total_comm
        else: s_data[3] = total_comm

        row = [
            idx,
            o.created_at.strftime('%d.%m.%Y') if o.created_at else "",
            o.external_id,
            "USDT",
            *b_data,
            *s_data
        ]
        ws.append(row)

    # Оформление
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=12):
        for cell in row:
            cell.border = thin_border
            cell.alignment = center_align if cell.row <= 3 else Alignment(horizontal='center')
            if cell.row <= 3: cell.font = bold_font

    col_widths = {'A': 6, 'B': 15, 'C': 25, 'D': 15, 'E': 15, 'F': 15, 'G': 18, 'H': 18, 'I': 15, 'J': 15, 'K': 18, 'L': 18}
    for k, v in col_widths.items(): ws.column_dimensions[k].width = v

    filename = f"report_{user_id}.xlsx"
    response = HttpResponse(content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    wb.save(response)
    return response


def admin_login(request):
    """Вход в админку"""
    if request.user.is_authenticated and request.user.is_superuser:
        return redirect('admin_users')
    
    if request.method == 'POST':
        form = AuthenticationForm(request, data=request.POST)
        if form.is_valid():
            user = form.get_user()
            if user.is_superuser:
                login(request, user)
                return redirect(request.GET.get('next', 'admin_users'))
            else:
                messages.error(request, "Нет прав администратора.")
        else:
            # Ошибки формы автоматически будут доступны в шаблоне
            pass
    else:
        form = AuthenticationForm()
    
    # Шаблон лежит в custom_admin/login.html
    return render(request, 'custom_admin/login.html', {'form': form})


@login_required(login_url='admin_login')
def admin_logout(request):
    """Выход из админки"""
    logout(request)
    return redirect('admin_login')


@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_orders_editor(request):
    """Редактор ордеров"""
    order = None
    user_details = None
    search_id = request.GET.get('order_id_search')
    
    if search_id:
        search_id = search_id.strip()
        order = Order.objects.filter(external_id=search_id).first()
        if not order and search_id.isdigit():
            order = Order.objects.filter(id=search_id).first()
            
        if order:
            from .models import BankDetail
            user_details = BankDetail.objects.filter(user=order.user)
        else:
            messages.error(request, f"Заказ '{search_id}' не найден.")

    if request.method == 'POST' and 'save_order' in request.POST:
        target_pk = request.POST.get('target_order_pk')
        try:
            current_order = Order.objects.get(pk=target_pk)
            current_order.external_id = request.POST.get('external_id')
            current_order.exchange_type = request.POST.get('exchange_type')
            current_order.bank_detail_id = request.POST.get('bank_detail_id')
            current_order.operation_type = request.POST.get('operation_type')
            current_order.price = request.POST.get('price')
            current_order.amount = request.POST.get('amount')
            current_order.cost = request.POST.get('cost')
            current_order.commission = request.POST.get('commission')
            current_order.commission_type = request.POST.get('commission_type')
            
            date_raw = request.POST.get('created_at')
            if date_raw: current_order.created_at = date_raw
            
            current_order.save()
            messages.success(request, "Заказ обновлен.")
            return redirect('admin_orders_editor')
        except Order.DoesNotExist:
            messages.error(request, "Ошибка сохранения.")

    return render(request, 'custom_admin/orders_editor.html', {
        'order': order,
        'user_details': user_details
    })



@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_turnover_control(request):
    return render(request, 'custom_admin/turnover_control.html')




User = get_user_model()




@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_statistics_24h(request):
    # Получаем параметры
    f_user = request.GET.get('user', '')
    f_exchange = request.GET.get('exchange', '')
    f_type = request.GET.get('type', '')
    f_limit = request.GET.get('limit', '50')

    # Проверяем, нажата ли кнопка "Обновить" (или применены фильтры)
    # Если параметров нет вообще в URL - это первый заход
    is_update_action = bool(request.GET) 

    orders = []
    
    # Логика запуска (только если нажали Обновить)
    if is_update_action:
        # Кого сканируем?
        if f_user and f_user.isdigit():
            users_qs = User.objects.filter(id=f_user)
        else:
            # ВСЕ ПОЛЬЗОВАТЕЛИ (но только те, у кого есть ключи)
            # Это фильтрует "мусорных" юзеров и ускоряет процесс
            users_qs = User.objects.exclude(bybit_api_key__isnull=True).exclude(bybit_api_key='')

        # Запускаем параллельный сервис
        filters = {'type': f_type, 'exchange': f_exchange}
        orders = get_orders_parallel(users_qs, filters)

    # Статистика (считаем "на лету" по полученному списку)
    total_count = len(orders)
    buy_count = sum(1 for x in orders if x.operation_type == 'BUY')
    sell_count = sum(1 for x in orders if x.operation_type == 'SELL')
    total_sum = sum(x.cost for x in orders)

    # Пагинация
    try:
        limit = int(f_limit)
    except:
        limit = 50
        
    paginator = Paginator(orders, limit)
    page_obj = paginator.get_page(request.GET.get('page'))

    # Контекст
    all_users = User.objects.all().order_by('username')

    context = {
        'orders': page_obj,
        'users': all_users,
        
        # Сохраняем выбор в фильтрах
        'current_user': int(f_user) if f_user.isdigit() else '',
        'current_exchange': f_exchange,
        'current_type': f_type,
        'current_limit': f_limit,
        
        # Статы
        'total_orders': total_count,
        'buy_count': buy_count,
        'sell_count': sell_count,
        'total_amount': total_sum,
        
        # Флаг, искали мы что-то или нет
        'is_search': is_update_action
    }

    return render(request, 'custom_admin/statistics_24.html', context)


# === API (только для админов) ===
@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def api_search_users(request):
    query = request.GET.get('q', '').strip()
    if len(query) < 1: return JsonResponse([], safe=False)
    
    users = User.objects.filter(Q(username__icontains=query) | Q(id__icontains=query))[:10]
    return JsonResponse([{'id': u.id, 'username': u.username} for u in users], safe=False)


@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def api_get_turnover(request, user_id):
    start_date = request.GET.get('start')
    end_date = request.GET.get('end')
    
    orders = Order.objects.filter(user_id=user_id, created_at__date__range=[start_date, end_date]).order_by('-created_at')
    
    buy_orders = orders.filter(operation_type='BUY')
    sell_orders = orders.filter(operation_type='SELL')
    
    buy_sum = buy_orders.aggregate(Sum('amount'))['amount__sum'] or 0
    sell_sum = sell_orders.aggregate(Sum('amount'))['amount__sum'] or 0
    
    def fmt(val): return f"{val:,.2f}".replace(',', ' ').replace('.', ',')
    def serialize(qs): 
        return [{'id': o.pk, 'amount': float(o.amount), 'cost': float(o.cost) if hasattr(o,'cost') else 0, 'date': o.created_at.strftime('%d.%m %H:%M')} for o in qs]

    data = {
        'buy_sum': fmt(buy_sum), 'buy_count': buy_orders.count(),
        'sell_sum': fmt(sell_sum), 'sell_count': sell_orders.count(),
        'total_sum': fmt(buy_sum + sell_sum), 'profit': fmt(sell_sum - buy_sum),
        'buy_orders': serialize(buy_orders), 'sell_orders': serialize(sell_orders),
    }
    return JsonResponse(data)