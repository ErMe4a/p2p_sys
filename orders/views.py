from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from .services import sync_bybit_orders

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


#ПОЛЬЗАК ПАНЕЛЬ____________________________________________________________________________________________________________________

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






#АДМИН ПАНЕЛЬ____________________________________________________________________________________________________________________

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




def export_excel_report(request):
    # 1. Получение параметров из запроса
    user_id = request.GET.get('user_id')
    start_date = request.GET.get('start')  # Ожидается формат YYYY-MM-DD
    end_date = request.GET.get('end')      # Ожидается формат YYYY-MM-DD
    bank_id = request.GET.get('bank_id')
    op_type = request.GET.get('type')

    # Получаем данные с сортировкой по дате
    orders = Order.objects.filter(user_id=user_id).order_by('created_at')

    # Применяем фильтры
    if start_date:
        orders = orders.filter(created_at__date__gte=start_date)
    if end_date:
        orders = orders.filter(created_at__date__lte=end_date)
    if bank_id and bank_id.isdigit():
        orders = orders.filter(bank_detail_id=bank_id)
    if op_type:
        orders = orders.filter(operation_type=op_type)

    # 2. Создание Excel книги
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Отчет"

    # Стили
    thin_side = Side(style='thin')
    thin_border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)
    bold_font = Font(bold=True)
    center_align = Alignment(horizontal='center', vertical='center', wrap_text=True)

    # 3. Формирование шапки (как в образце)
    ws.merge_cells('A1:L1')
    ws['A1'] = "Учет приобретенной и проданной цифровой валюты (ЦВ)"
    ws['A1'].font = Font(size=14, bold=True)
    ws['A1'].alignment = Alignment(horizontal='center')

    ws.merge_cells('A2:A3')
    ws['A2'] = "№ п/п"
    ws.merge_cells('B2:B3')
    ws['B2'] = "Дата операции"
    ws.merge_cells('C2:C3')
    ws['C2'] = "Номер документа"
    ws.merge_cells('D2:D3')
    ws['D2'] = "Наименование ЦВ"
    
    ws.merge_cells('E2:H2')
    ws['E2'] = "Приобретение цифровой валюты"
    
    ws.merge_cells('I2:L2')
    ws['I2'] = "Продажа цифровой валюты"

    sub_headers = [
        "", "", "", "",
        "Кол-во покупки", "Курс покупки", "Стоимость покупки, руб.", "Комиссия покупки, руб.",
        "Кол-во продажи", "Курс продажи", "Стоимость продажи, руб.", "Комиссия продажи, руб."
    ]
    ws.append(sub_headers)

    # 4. Заполнение данными
    for idx, o in enumerate(orders, 1):
        b_qty, b_price, b_cost, b_comm = "", "", "", ""
        s_qty, s_price, s_cost, s_comm = "", "", "", ""

        # Расчет комиссии (процент или фиксированная сумма)
        comm_val = float(o.commission or 0)
        total_comm = (float(o.cost) * comm_val / 100) if o.commission_type == 'PERCENT' else comm_val

        if o.operation_type == 'BUY':
            b_qty, b_price, b_cost, b_comm = o.amount, o.price, o.cost, total_comm
        else:
            s_qty, s_price, s_cost, s_comm = o.amount, o.price, o.cost, total_comm

        ws.append([
            idx,
            o.created_at.strftime('%d.%m.%Y') if o.created_at else "",
            o.external_id,
            "USDT",
            b_qty, b_price, b_cost, b_comm,
            s_qty, s_price, s_cost, s_comm
        ])

    # 5. Отрисовка границ для всех заполненных ячеек
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=12):
        for cell in row:
            cell.border = thin_border
            if cell.row <= 3: # Стили для заголовков
                cell.font = bold_font
                cell.alignment = center_align
            else: # Стили для строк данных
                cell.alignment = Alignment(horizontal='center')

    # 6. Настройка ширины колонок
    column_widths = {'A': 6, 'B': 15, 'C': 25, 'D': 15, 'E': 15, 'F': 15, 'G': 18, 'H': 18, 'I': 15, 'J': 15, 'K': 18, 'L': 18}
    for col_letter, width in column_widths.items():
        ws.column_dimensions[col_letter].width = width

    # 7. Формирование динамического названия файла
    # Используем "start" и "end", если даты не выбраны в фильтре
    fname_start = start_date if start_date else "start"
    fname_end = end_date if end_date else "end"
    filename = f"orders_report_{fname_start}_{fname_end}_{user_id}.xlsx"

    # 8. Отправка ответа
    response = HttpResponse(content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    wb.save(response)
    
    return response

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
    user_details = None
    search_id = request.GET.get('order_id_search')
    
    if search_id:
        search_id = search_id.strip()
        order = Order.objects.filter(external_id=search_id).first()
        if not order and search_id.isdigit():
            order = Order.objects.filter(id=search_id).first()
            
        if order:
            # Получаем все реквизиты владельца этого заказа, чтобы выбрать банк по имени
            from .models import BankDetail # Убедись, что модель импортирована
            user_details = BankDetail.objects.filter(user=order.user)
        else:
            messages.error(request, f"Заказ '{search_id}' не найден.")

    if request.method == 'POST' and 'save_order' in request.POST:
        target_pk = request.POST.get('target_order_pk')
        try:
            current_order = Order.objects.get(pk=target_pk)
            
            # Обновляем все параметры
            current_order.external_id = request.POST.get('external_id')
            current_order.exchange_type = request.POST.get('exchange_type')
            current_order.bank_detail_id = request.POST.get('bank_detail_id') # Сохраняем выбранный банк
            current_order.operation_type = request.POST.get('operation_type')
            current_order.price = request.POST.get('price')
            current_order.amount = request.POST.get('amount')
            current_order.cost = request.POST.get('cost')
            current_order.commission = request.POST.get('commission')
            current_order.commission_type = request.POST.get('commission_type')
            
            date_raw = request.POST.get('created_at')
            if date_raw:
                current_order.created_at = date_raw
            
            current_order.save()
            messages.success(request, "Изменения успешно сохранены.")
            return redirect('admin_orders_editor') 
            
        except Order.DoesNotExist:
            messages.error(request, "Ошибка: заказ не найден.")

    return render(request, 'admin/orders_editor.html', {
        'order': order,
        'user_details': user_details
    })




# Получаем правильную модель пользователя (твою orders.User)
User = get_user_model()

# Проверка: пускаем только Суперюзера (Админа)
def is_admin(user):
    return user.is_superuser

@login_required
@user_passes_test(is_admin, login_url='/')
def admin_turnover_control(request):
    return render(request, 'admin/turnover_control.html')

# API: Живой поиск по ВСЕМ пользователям
@login_required
@user_passes_test(is_admin)
def api_search_users(request):
    query = request.GET.get('q', '').strip()
    if len(query) < 1:
        return JsonResponse([], safe=False)
    
    # Теперь User.objects ссылается на твою таблицу orders_user
    users = User.objects.filter(
        Q(username__icontains=query) | Q(id__icontains=query)
    )[:10]
    
    results = [{'id': u.id, 'username': u.username} for u in users]
    return JsonResponse(results, safe=False)

# API: Получение статистики
@login_required
@user_passes_test(is_admin)
def api_get_turnover(request, user_id):
    start_date = request.GET.get('start')
    end_date = request.GET.get('end')
    
    orders = Order.objects.filter(
        user_id=user_id, 
        created_at__date__range=[start_date, end_date]
    ).order_by('-created_at')
    
    buy_orders = orders.filter(operation_type='BUY')
    sell_orders = orders.filter(operation_type='SELL')
    
    buy_sum = buy_orders.aggregate(Sum('amount'))['amount__sum'] or 0
    sell_sum = sell_orders.aggregate(Sum('amount'))['amount__sum'] or 0
    
    def fmt(val):
        return f"{val:,.2f}".replace(',', ' ').replace('.', ',')

    def serialize(qs):
        return [{
            'id': o.pk, 
            'amount': float(o.amount),
            'cost': float(o.cost) if hasattr(o, 'cost') else 0,
            'date': o.created_at.strftime('%d.%m %H:%M')
        } for o in qs]

    data = {
        'buy_sum': fmt(buy_sum),
        'buy_count': buy_orders.count(),
        'sell_sum': fmt(sell_sum),
        'sell_count': sell_orders.count(),
        'total_sum': fmt(buy_sum + sell_sum),
        'profit': fmt(sell_sum - buy_sum),
        'buy_orders': serialize(buy_orders),
        'sell_orders': serialize(sell_orders),
    }
    return JsonResponse(data)


@login_required
def admin_statistics(request):
    if not request.user.is_superuser: return redirect('my_orders')
    return render(request, 'admin/statistics.html')


