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
from django.db.models import Sum, Q
from django.contrib.auth.models import User  # Или твоя модель пользователя



from django.contrib.auth.decorators import login_required, user_passes_test
from django.db.models import Sum, Q # <--- ВАЖНОЕ ИЗМЕНЕНИЕ
import openpyxl
from openpyxl.styles import Alignment, Font, Border, Side
from .bybit_api import sync_bybit_orders
from .mexc_api import  sync_mexc_orders
from django.core.paginator import Paginator
from .receipt_service import create_or_update_and_send_receipt
from .bybit_service import get_orders_parallel as get_bybit_orders
from .mexc_service import get_mexc_orders_parallel
from django.contrib import messages
from django.utils.dateparse import parse_datetime
from decimal import Decimal


from django.contrib.auth import update_session_auth_hash # ЭТО ВАЖНО


#ПОЛЬЗАК ПАНЕЛЬ____________________________________________________________________________________________________________________


User = get_user_model()

import zipfile
import io
import os
from django.contrib.auth.decorators import user_passes_test
from django.utils.dateparse import parse_date
from datetime import datetime, time


from django.utils import timezone
# Импортируем функцию из твоего receipt_service.py


from django.core.cache import cache # Импортируем кэш


# Импорт твоих функций
# from .services import sync_bybit_orders, sync_mexc_orders 

# === ХЕЛПЕР ДЛЯ ОЧИСТКИ ЧИСЕЛ ===



def safe_decimal(value):
    """
    Превращает '1,4' -> 1.4, '1 000' -> 1000.0
    Если пусто или ошибка -> возвращает 0
    """
    if not value:
        return 0
    # Меняем запятую на точку, убираем пробелы
    clean_val = str(value).replace(' ', '').replace(',', '.').strip()
    try:
        return float(clean_val)
    except ValueError:
        return 0

@login_required
def my_orders_list(request):
    # Грузим список банков
    default_banks = BankDetail.objects.filter(is_deleted=False).order_by('id')
    
    # ЛОГИКА СОЗДАНИЯ
    if request.method == 'POST' and 'create_order' in request.POST:
        raw_date = request.POST.get('created_at')
        if raw_date:
            # 1. Парсим строку в дату (пока без зоны)
            naive_date = datetime.strptime(raw_date, '%Y-%m-%dT%H:%M')
            # 2. Добавляем текущую временную зону проекта (делаем дату "aware")
            order_date = timezone.make_aware(naive_date)
        else:
            # Если дату не выбрали, берем текущую
            order_date = timezone.now()

        # 1. Сохраняем настройки формы В ТОМ ВИДЕ, КАК ВВЕЛ ЮЗЕР
        request.session['saved_order_form'] = {
            'operation_type': request.POST.get('operation_type'),
            'exchange': request.POST.get('exchange'),
            'details': request.POST.get('details'),
            'commission_value': request.POST.get('commission_value'),
            'commission_type': request.POST.get('commission_type'),
            'created_at': raw_date
        }

        bank_id = request.POST.get('details') 
        bank_instance = None
        if bank_id:
            bank_instance = BankDetail.objects.filter(id=bank_id, is_deleted=False).first()

        # 2. Очищаем числа перед сохранением в БД (safe_decimal)
        price_val = safe_decimal(request.POST.get('price'))
        amount_val = safe_decimal(request.POST.get('amount'))
        cost_val = safe_decimal(request.POST.get('cost'))
        commission_val = safe_decimal(request.POST.get('commission_value'))

        # === НОВАЯ ЛОГИКА: ОПРЕДЕЛЯЕМ ПРОЦЕНТ БИРЖИ ===
        exchange_name = request.POST.get('exchange', '').lower()
        user_comm_rate = 0.0
        
        if 'bybit' in exchange_name:
            user_comm_rate = request.user.bybit_commission
        elif 'htx' in exchange_name or 'huobi' in exchange_name:
            user_comm_rate = request.user.htx_commission
        elif 'mexc' in exchange_name:
            user_comm_rate = request.user.mexc_commission
        elif 'bitget' in exchange_name:
            user_comm_rate = request.user.bitget_commission
        elif 'telegram' in exchange_name:
            user_comm_rate = request.user.telegram_commission
        # ===============================================

        external_id = request.POST.get('external_id')

        # Создаем ордер
        order = Order.objects.create(
            user=request.user,
            external_id=external_id,
            
            price=price_val,
            amount=amount_val,
            cost=cost_val,
            commission=commission_val,
            
            operation_type=request.POST.get('operation_type'),
            exchange_type=request.POST.get('exchange'),
            bank_detail=bank_instance,
            commission_type=request.POST.get('commission_type'),
            
            # ЗАПИСЫВАЕМ ИСТОРИЧЕСКИЙ ПРОЦЕНТ
            exchange_commission_rate=user_comm_rate,
            
            screenshot=request.FILES.get('screenshot'),
            created_at=order_date
        )

        # !!! ВАЖНОЕ ИЗМЕНЕНИЕ: УДАЛЯЕМ ИЗ НЕОБРАБОТАННЫХ !!!
        if external_id:
            UnprocessedOrder.objects.filter(
                user=request.user, 
                order_id=external_id
            ).delete()
        # !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

        # 4. ЛОГИКА ЧЕКА (Эвотор)
        need_receipt = request.POST.get('need_receipt') == 'on'
        
        if need_receipt:
            contact_email = request.POST.get('receipt_contact')
            if not contact_email:
                contact_email = request.user.email

            receipt_data = {
                "contact": contact_email, 
                "sum": order.cost,
                "price": order.price,
                "amount": order.amount,
            }
            
            create_or_update_and_send_receipt(order, receipt_data)

        return redirect('my_orders')

    orders = Order.objects.filter(user=request.user).order_by('-created_at')
    
    # Достаем сохраненные настройки
    saved_data = request.session.get('saved_order_form', {})
    
    if not saved_data:
        saved_data = {
            'operation_type': 'BUY',
            'exchange': 'Bybit',
            'commission_type': 'PERCENT'
        }
    
    if saved_data.get('created_at'):
        current_time = saved_data['created_at']
    else:
        current_time = timezone.now().strftime('%Y-%m-%dT%H:%M')

    return render(request, 'orders/my_orders.html', {
        'orders': orders,
        'default_banks': default_banks,
        'current_time': current_time,
        'saved_data': saved_data
    })

@login_required
def edit_order(request, order_id):
    order = get_object_or_404(Order, id=order_id, user=request.user)
    
    if request.method == 'POST':
        # 1. Получаем название банка из формы
        details_name = request.POST.get('details')
        
        # Обработка банка
        if details_name:
            # Ищем банк просто по имени (так как модель общая)
            bank_instance, created = BankDetail.objects.get_or_create(
                name=details_name
            )
            order.bank_detail = bank_instance
        # Если details_name пустой, мы просто не меняем order.bank_detail 
        # или можно добавить else: order.bank_detail = None, если нужно удалять банк

        order.external_id = request.POST.get('external_id')
        order.price = request.POST.get('price') or 0
        order.amount = request.POST.get('amount') or 0
        order.cost = request.POST.get('cost') or 0
        order.operation_type = request.POST.get('operation_type')
        order.exchange_type = request.POST.get('exchange')

        # УДАЛЕНО: order.bank_detail = bank_instance 
        # (Эта строка вызывала ошибку, так как bank_instance может не существовать)
        
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
        # 1. Сохраняем основные данные
        user.evotor_login = request.POST.get('evotor_login')
        user.evotor_password = request.POST.get('evotor_password')
        user.kkt_id = request.POST.get('kkt_id')
        user.email = request.POST.get('email')
        user.payment_address = request.POST.get('payment_address')
        user.tax_type = request.POST.get('tax_type')
        user.inn = request.POST.get('inn')

        # 2. Сохраняем ключи API
        user.htx_access_key = request.POST.get('htx_key')
        user.htx_private_key = request.POST.get('htx_secret')
        user.mexc_api_key = request.POST.get('mexc_key')
        user.mexc_api_secret = request.POST.get('mexc_secret')
        user.bybit_api_key = request.POST.get('bybit_key')
        user.bybit_api_secret = request.POST.get('bybit_secret')

        # 3. Сохраняем комиссии бирж
        user.bybit_commission = float(request.POST.get('bybit_commission') or 0.3)
        user.htx_commission = float(request.POST.get('htx_commission') or 0)
        user.mexc_commission = float(request.POST.get('mexc_commission') or 0)
        user.bitget_commission = float(request.POST.get('bitget_commission') or 0)
        user.telegram_commission = float(request.POST.get('telegram_commission') or 0.9)

        # 3. ЛОГИКА СМЕНЫ ПАРОЛЯ
        new_password = request.POST.get('new_password')
        if new_password and new_password.strip():
            user.set_password(new_password)
            user.save()
            update_session_auth_hash(request, user) # Важно: чтобы не разлогинило
            messages.success(request, "Пароль успешно изменен!")
        else:
            user.save()
            messages.success(request, "Настройки сохранены.")
            
        return redirect('settings') # Возврат для POST запроса

    # ВАЖНО: Эта строка должна быть ВНЕ блока if
    # Она срабатывает, когда ты просто заходишь на страницу (GET запрос)
    return render(request, 'orders/settings.html', {'user': user})




@login_required
def unprocessed_orders_list(request):
    """
    Страница необработанных ордеров.
    Синхронизирует Bybit и MEXC (не чаще 1 раза в 3 минуты).
    """
    user = request.user
    
    # 1. Сразу проверяем наличие ключей (чтобы не запускать логику впустую)
    bybit_ok = bool(user.bybit_api_key and user.bybit_api_secret)
    mexc_ok = bool(user.mexc_api_key and user.mexc_api_secret)

    # 2. УМНАЯ СИНХРОНИЗАЦИЯ (Защита от бана)
    # Создаем ключ кэша: уникальный для каждого юзера
    cache_key = f"sync_cooldown_{user.id}"
    
    # Если кэша НЕТ (значит прошло 3 минуты или это первый заход)
    if not cache.get(cache_key):
        
        # --- BYBIT ---
        if bybit_ok:
            try:
                # count - это то, что возвращает твоя функция (return len(new_orders))
                count = sync_bybit_orders(user)
                if count > 0:
                    messages.success(request, f"Bybit: +{count} новых ордеров.")
            except Exception as e:
                print(f"Bybit Sync Error: {e}")
                # Ошибку юзеру можно не показывать каждый раз, чтобы не раздражать

        # --- MEXC ---
        if mexc_ok:
            try:
                # sync_mexc_orders(user) 
                pass
            except Exception as e:
                print(f"MEXC Sync Error: {e}")

        # СТАВИМ БЛОКИРОВКУ НА 3 МИНУТЫ (180 секунд)
        # В течение этого времени скрипт не будет стучаться на биржи
        cache.set(cache_key, True, 180)
        
    else:
        # Если кэш есть, мы просто пропускаем синхронизацию
        # Можно вывести в консоль для отладки
        # print(f"User {user.username}: Sync skipped (cooldown active)")
        pass

    # 3. Сообщение, если ключей нет совсем
    if not bybit_ok and not mexc_ok:
        messages.warning(request, "API ключи не настроены. Добавьте Bybit или MEXC.")

    # 4. Загрузка из БД (работает всегда мгновенно)
    unprocessed_orders = UnprocessedOrder.objects.filter(
        user=user
    ).order_by('-created_at')

    context = {
        'unprocessed_orders': unprocessed_orders,
        'bybit_configured': bybit_ok,
        'mexc_configured': mexc_ok
    }
    
    return render(request, 'orders/unprocessed.html', context)

@login_required
def delete_unprocessed_order(request, pk):
    try:
        order = UnprocessedOrder.objects.get(pk=pk, user=request.user)
        order.delete()
        messages.success(request, "Ордер удален из списка.")
    except UnprocessedOrder.DoesNotExist:
        messages.error(request, "Ордер не найден.")
    return redirect('unprocessed_orders_list')

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
            user_to_edit.mexc_api_key= request.POST.get('mexc_key')
            user_to_edit.mexc_api_secret = request.POST.get('mexc_secret')
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

    # Фильтрация дат
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

    ws.merge_cells('A1:M1')
    ws['A1'] = "Учет приобретенной и проданной цифровой валюты (ЦВ)"
    ws['A1'].font = Font(size=14, bold=True)
    ws['A1'].alignment = Alignment(horizontal='center')

    ws.merge_cells('A2:A3'); ws['A2'] = "№ п/п"
    ws.merge_cells('B2:B3'); ws['B2'] = "Дата операции"
    ws.merge_cells('C2:C3'); ws['C2'] = "Номер документа"
    ws.merge_cells('D2:D3'); ws['D2'] = "Наименование ЦВ"
    ws.merge_cells('E2:H2'); ws['E2'] = "Приобретение цифровой валюты"
    ws.merge_cells('I2:M2'); ws['I2'] = "Продажа цифровой валюты"

    ws.append([
        "", "", "", "", 
        "Кол-во", "Курс", "Стоимость", "Комиссия", 
        "Кол-во", "Курс", "Стоимость", "Комиссия", "Комиссия биржи"
    ])

    # Переменные для итогов
    t_buy_qty = 0; t_buy_cost = 0; t_buy_comm = 0
    t_sell_qty = 0; t_sell_cost = 0; t_sell_comm = 0; t_sell_exch_comm = 0
    
    buys_list = []

    for idx, o in enumerate(orders, 1):
        comm_val = float(o.commission or 0)
        total_comm = (float(o.cost) * comm_val / 100) if o.commission_type == 'PERCENT' else comm_val

        amount_float = float(o.amount or 0)
        cost_float = float(o.cost or 0)
        price_float = float(o.price or 0)

        if o.operation_type == 'BUY':
            b_data = [amount_float, price_float, cost_float, total_comm]
            s_data = ["", "", "", "", ""]
            
            t_buy_qty += amount_float
            t_buy_cost += cost_float
            t_buy_comm += total_comm
            
            buys_list.append({'qty': amount_float, 'cost': cost_float})

        else: # SELL
            b_data = ["", "", "", ""]
            
            hist_percent = float(o.exchange_commission_rate or 0)
            exchange_comm_val = (amount_float * hist_percent) / 100

            s_data = [amount_float, price_float, cost_float, total_comm, exchange_comm_val]
            
            t_sell_qty += amount_float
            t_sell_cost += cost_float
            t_sell_comm += total_comm
            t_sell_exch_comm += exchange_comm_val

        row = [
            idx,
            o.created_at.strftime('%d.%m.%Y') if o.created_at else "",
            o.external_id,
            "USDT",
            *b_data,
            *s_data
        ]
        ws.append(row)

    # === РАСЧЕТ НИЖНЕЙ ПЛАШКИ ===
    remainder_qty = t_buy_qty - t_sell_qty - t_sell_exch_comm
    
    remainder_cost = 0
    temp_qty = remainder_qty
    
    for buy in reversed(buys_list):
        if temp_qty <= 0: break
        
        if buy['qty'] >= temp_qty:
            buy_price_unit = buy['cost'] / buy['qty'] if buy['qty'] else 0
            remainder_cost += temp_qty * buy_price_unit
            temp_qty = 0
        else:
            remainder_cost += buy['cost']
            temp_qty -= buy['qty']
            
    equalized_buy_cost = t_buy_cost - remainder_cost
    profit = t_sell_cost - equalized_buy_cost - t_buy_comm - t_sell_comm
    remainder_price = (remainder_cost / remainder_qty) if remainder_qty > 0 else 0

    # === ЗАПИСЬ ИТОГОВ В EXCEL ===
    ws.append([])

    row_trade_res = [
        "Торговый результат по итогам дня:", "", "", "",
        t_buy_qty, "", t_buy_cost, t_buy_comm,
        t_sell_qty, "", t_sell_cost, t_sell_comm, t_sell_exch_comm
    ]
    ws.append(row_trade_res)

    row_equal_res = [
        "Уравненный результат по итогам дня:", "", "", "",
        t_sell_qty, "", equalized_buy_cost, t_sell_comm,
        t_sell_qty, "", t_sell_cost, "", ""
    ]
    ws.append(row_equal_res)

    row_profit = [
        "Прибыль:", "", "", "",
        profit, "", "", "",
        "", "", "", "", ""
    ]
    ws.append(row_profit)

    row_remainder = [
        "Остаток (не реализованная ЦВ):", "", "", "",
        remainder_qty, remainder_price, remainder_cost, 0,
        "", "", "", "", ""
    ]
    ws.append(row_remainder)

    # Оформление
    # ИСПРАВЛЕНИЕ ОШИБКИ: Заменили cell.col_idx на cell.column
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=13):
        for cell in row:
            cell.border = thin_border
            
            # cell.column возвращает числовой индекс (1, 2, 3...)
            if cell.column == 1 and cell.row > len(orders) + 3:
                 cell.alignment = Alignment(horizontal='left')
            else:
                 cell.alignment = center_align if cell.row <= 3 else Alignment(horizontal='center')
            
            if cell.row <= 3: cell.font = bold_font

    col_widths = {
        'A': 35, 'B': 15, 'C': 25, 'D': 15, 
        'E': 15, 'F': 15, 'G': 18, 'H': 18, 
        'I': 15, 'J': 15, 'K': 18, 'L': 18, 'M': 18
    }
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
    """
    Редактор ордеров в админке.
    """
    order = None
    all_banks = None
    search_query = request.GET.get('order_id_search')
    
    # 1. Логика поиска ордера
    if search_query:
        search_query = search_query.strip()
        
        # ИСПРАВЛЕНИЕ: используем external_id вместо order_id
        order = Order.objects.filter(external_id__iexact=search_query).first()
        
        # Если не нашли по внешнему ID, пробуем по внутреннему ID (PK)
        if not order and search_query.isdigit():
            order = Order.objects.filter(id=int(search_query)).first()
            
        if order:
            all_banks = BankDetail.objects.filter(is_deleted=False).order_by('name')
        else:
            messages.error(request, f"Ордер '{search_query}' не найден.")

    # 2. Логика сохранения изменений
    if request.method == 'POST' and 'save_order' in request.POST:
        target_pk = request.POST.get('target_order_pk')
        try:
            current_order = Order.objects.get(pk=target_pk)
            
            # --- Обновляем поля ---
            # ИСПРАВЛЕНИЕ: сохраняем в external_id
            current_order.external_id = request.POST.get('external_id') 
            
            current_order.exchange_type = request.POST.get('exchange_type')
            current_order.operation_type = request.POST.get('operation_type')
            
            # Банк
            bank_id = request.POST.get('bank_detail_id')
            if bank_id:
                current_order.bank_detail_id = bank_id
            
            # Числовые поля
            def to_decimal(val):
                if not val: return Decimal('0')
                return Decimal(str(val).replace(',', '.'))

            current_order.price = to_decimal(request.POST.get('price'))
            current_order.amount = to_decimal(request.POST.get('amount'))
            
            # Проверка имени поля для стоимости (cost или total_amount)
            # Судя по ошибке Django, у тебя есть поле 'cost', используем его
            current_order.cost = to_decimal(request.POST.get('cost'))

            current_order.commission = to_decimal(request.POST.get('commission'))
            current_order.commission_type = request.POST.get('commission_type')
            
            # Дата
            date_raw = request.POST.get('created_at')
            if date_raw:
                dt = parse_datetime(date_raw)
                if dt:
                    current_order.created_at = dt
            
            current_order.save()
            messages.success(request, f"Ордер #{current_order.id} успешно обновлен.")
            
            # Редирект с использованием правильного поля
            return redirect(f'/p2p-admin/orders/?order_id_search={current_order.external_id}')
            
        except Order.DoesNotExist:
            messages.error(request, "Ошибка: Ордер не найден в базе при сохранении.")
        except Exception as e:
            messages.error(request, f"Ошибка сохранения: {str(e)}")

    return render(request, 'custom_admin/orders_editor.html', {
        'order': order,
        'all_banks': all_banks,
        'search_query': search_query
    })





@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_turnover_control(request):
    """
    Единая точка входа:
    1. Если action='search_users' -> ищет юзеров (JSON).
    2. Если action='get_turnover' -> считает оборот (JSON).
    3. Иначе -> отдает HTML страницу.
    """
    action = request.GET.get('action')

    # === ЛОГИКА 1: ПОИСК ПОЛЬЗОВАТЕЛЯ ===
    if action == 'search_users':
        q = request.GET.get('q', '').strip()
        if len(q) < 1:
            return JsonResponse([], safe=False)
        
        users = User.objects.filter(username__icontains=q)[:10]
        data = [{'id': u.id, 'username': u.username} for u in users]
        return JsonResponse(data, safe=False)

    # === ЛОГИКА 2: РАСЧЕТ ОБОРОТА ===
    if action == 'get_turnover':
        user_id = request.GET.get('target_user_id')
        start_date_str = request.GET.get('start')
        end_date_str = request.GET.get('end')

        if not user_id:
            return JsonResponse({'error': 'No user ID'}, status=400)

        orders = Order.objects.filter(user_id=user_id)

        if start_date_str and end_date_str:
            orders = orders.filter(created_at__range=[
                f"{start_date_str} 00:00:00", 
                f"{end_date_str} 23:59:59"
            ])

        buy_orders = orders.filter(operation_type='BUY').order_by('-created_at')
        sell_orders = orders.filter(operation_type='SELL').order_by('-created_at')

        # Считаем суммы (cost - это рубли)
        buy_sum = buy_orders.aggregate(Sum('cost'))['cost__sum'] or 0
        sell_sum = sell_orders.aggregate(Sum('cost'))['cost__sum'] or 0

        # Сериализация для таблицы
        def serialize(qs):
            res = []
            for o in qs:
                display_id = o.external_id if o.external_id else str(o.id)
                res.append({
                    'id': o.id,
                    'external_id': display_id,
                    'price': float(o.price),   # Курс
                    'amount': float(o.amount), # USDT (Объем)
                    'cost': float(o.cost),     # RUB (Стоимость)
                    'date': o.created_at.strftime('%d.%m.%Y %H:%M')
                })
            return res

        return JsonResponse({
            'buy_sum': buy_sum,
            'buy_count': buy_orders.count(),
            'sell_sum': sell_sum,
            'sell_count': sell_orders.count(),
            'total_sum': buy_sum + sell_sum,
            'profit': "{:.2f}".format(sell_sum - buy_sum),
            'buy_orders': serialize(buy_orders),
            'sell_orders': serialize(sell_orders),
        })

    # === ЛОГИКА 3: ПРОСТО ОТДАТЬ СТРАНИЦУ ===
    return render(request, 'custom_admin/turnover_control.html')




User = get_user_model()




@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_statistics_24h(request):
    f_user = request.GET.get('user', '')
    f_exchange = request.GET.get('exchange', '') # Bybit, MEXC, или пусто
    f_type = request.GET.get('type', '')
    f_limit = request.GET.get('limit', '50')

    is_update_action = bool(request.GET)
    orders = []

    if is_update_action:
        # --- 1. ОПРЕДЕЛЯЕМ ПОЛЬЗОВАТЕЛЕЙ ---
        if f_user and f_user.isdigit():
            # Если выбран конкретный пользователь
            users_qs = User.objects.filter(id=f_user)
        else:
            # Если "Все", берем тех, у кого есть хоть какие-то ключи
            users_qs = User.objects.filter(
                Q(bybit_api_key__isnull=False) & ~Q(bybit_api_key='') |
                Q(mexc_api_key__isnull=False) & ~Q(mexc_api_key='')
            )

        filters = {'type': f_type, 'exchange': f_exchange}
        
        # --- 2. СБОР ДАННЫХ ---
        
        # BYBIT
        # Запускаем, если выбран "Bybit" или "Все источники"
        if f_exchange == 'Bybit' or f_exchange == '' or f_exchange == '1':
            # Фильтруем юзеров, у кого есть ключи Bybit, чтобы не гонять пустышки
            bybit_users = users_qs.exclude(bybit_api_key__isnull=True).exclude(bybit_api_key='')
            bybit_data = get_bybit_orders(bybit_users, filters)
            orders.extend(bybit_data)

        # MEXC
        # Запускаем, если выбран "MEXC" или "Все источники"
        if f_exchange == 'MEXC' or f_exchange == '':
            # Фильтруем юзеров, у кого есть ключи MEXC
            mexc_users = users_qs.exclude(mexc_api_key__isnull=True).exclude(mexc_api_key='')
            mexc_data = get_mexc_orders_parallel(mexc_users, filters)
            orders.extend(mexc_data)

        # --- 3. ФИНАЛЬНАЯ СОРТИРОВКА ---
        # Сортируем общий список по дате (свежие сверху)
        orders.sort(key=lambda x: x.created_at, reverse=True)

    # Статистика "на лету"
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

    all_users = User.objects.all().order_by('username')

    context = {
        'orders': page_obj,
        'users': all_users,
        'current_user': int(f_user) if f_user.isdigit() else '',
        'current_exchange': f_exchange,
        'current_type': f_type,
        'current_limit': f_limit,
        'total_orders': total_count,
        'buy_count': buy_count,
        'sell_count': sell_count,
        'total_amount': total_sum,
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



@user_passes_test(lambda u: u.is_superuser)
def export_screenshots_view(request):
    # 1. Получаем параметры
    user_id = request.GET.get('user_id')
    start_str = request.GET.get('start')
    end_str = request.GET.get('end')
    bank_id = request.GET.get('bank')
    op_type = request.GET.get('type')

    if not user_id:
        return HttpResponse("User ID required", status=400)

    # 2. Базовая фильтрация
    orders = Order.objects.filter(user_id=user_id).exclude(screenshot='').exclude(screenshot__isnull=True)

    # 3. Фильтры
    if start_str:
        start_date = parse_date(start_str)
        if start_date:
            start_dt = timezone.make_aware(datetime.combine(start_date, time.min))
            orders = orders.filter(created_at__gte=start_dt)
    
    if end_str:
        end_date = parse_date(end_str)
        if end_date:
            end_dt = timezone.make_aware(datetime.combine(end_date, time.max))
            orders = orders.filter(created_at__lte=end_dt)

    if op_type and op_type in ['BUY', 'SELL']:
        orders = orders.filter(operation_type=op_type)

    if bank_id and bank_id.isdigit():
        orders = orders.filter(bank_detail_id=int(bank_id))

    if not orders.exists():
        return HttpResponse("Нет скриншотов по выбранным критериям", content_type="text/plain; charset=utf-8")

    # 4. Создание архива
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for order in orders:
            try:
                # Проверяем, существует ли файл
                if order.screenshot and order.screenshot.storage.exists(order.screenshot.name):
                    
                    # === ИЗМЕНЕНИЕ: БЕРЕМ ОРИГИНАЛЬНОЕ ИМЯ ФАЙЛА ===
                    # os.path.basename берет "d12345.png" из пути "uploads/2026/d12345.png"
                    filename = os.path.basename(order.screenshot.name)
                    
                    # Если вдруг имя файла пустое (маловероятно), генерируем запасное
                    if not filename:
                        filename = f"order_{order.id}.png"

                    # Читаем и пишем в архив
                    with order.screenshot.open('rb') as f:
                        zip_file.writestr(filename, f.read())
                        
            except Exception as e:
                print(f"Ошибка с файлом ордера {order.id}: {e}")
                continue

    zip_buffer.seek(0)
    response = HttpResponse(zip_buffer, content_type='application/zip')
    
    # === ИСПРАВЛЕНИЕ ОШИБКИ DATETIME ===
    # Используем timezone.now() вместо datetime.now()
    filename_zip = f"screens_{user_id}_{timezone.now().strftime('%Y%m%d')}.zip"
    
    response['Content-Disposition'] = f'attachment; filename="{filename_zip}"'
    
    return response


