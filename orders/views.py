# --- Стандартная библиотека ---
import io
import json
import os
import zipfile
from datetime import datetime, date, time, timezone as dt_timezone
import json as _json
from itertools import groupby as _groupby

# --- Django ---
from django.contrib import messages
from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.decorators import login_required, user_passes_test
from django.contrib.auth.hashers import make_password
from django.core.cache import cache
from django.core.paginator import Paginator
from django.db.models import Q, Sum
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from decimal import Decimal, ROUND_DOWN
import openpyxl
from openpyxl.styles import Alignment, Border, Font, Side
from django.contrib.auth.forms import AuthenticationForm

# --- Проект ---
from .bybit_api import sync_bybit_orders
from .bybit_service import get_orders_parallel as get_bybit_orders
from .mexc_api import sync_mexc_orders
from .mexc_service import get_mexc_orders_parallel
from .models import BankDetail, IgnoredOrder, Order, UnprocessedOrder, UserExpense
from .receipt_service import create_or_update_and_send_receipt
from zoneinfo import ZoneInfo
MSK = ZoneInfo('Europe/Moscow')
# --- Инициализация ---
User = get_user_model()
SYSTEM_START = datetime(2026, 2, 1, 0, 0, 0, tzinfo=dt_timezone.utc)


#ПОЛЬЗАК ПАНЕЛЬ____________________________________________________________________________________________________________________






def safe_decimal(value):
    """
    Превращает '1,4' -> 1.4, '1 000' -> 1000.0
    Если пусто или ошибка -> возвращает 0
    """
    if not value:
        return 0
    clean_val = str(value).replace(' ', '').replace(',', '.').strip()
    try:
        return float(clean_val)
    except ValueError:
        return 0


def truncate(value, places=3):
    """
    Обрезает число до нужного кол-ва знаков БЕЗ округления.
    86.3429  -> 86.342
    523.1239 -> 523.123
    46123.4567 -> 46123.456
    """
    try:
        d = Decimal(str(float(value)))
        factor = Decimal(10) ** -places
        return float(d.quantize(factor, rounding=ROUND_DOWN))
    except Exception:
        return 0.0


@login_required
def my_orders_list(request):
    # Грузим список банков
    default_banks = BankDetail.objects.filter(is_deleted=False).order_by('id')

    # ЛОГИКА СОЗДАНИЯ
    if request.method == 'POST' and 'create_order' in request.POST:
        raw_date = request.POST.get('created_at')
        if raw_date:
            naive_date = datetime.strptime(raw_date, '%Y-%m-%dT%H:%M')
            order_date = timezone.make_aware(naive_date)
        else:
            order_date = timezone.now()

        # 1. Сохраняем настройки формы В ТОМ ВИДЕ, КАК ВВЕЛ ЮЗЕР
        request.session['saved_order_form'] = {
            'operation_type':  request.POST.get('operation_type'),
            'exchange':        request.POST.get('exchange'),
            'details':         request.POST.get('details'),
            'commission_value': request.POST.get('commission_value'),
            'commission_type': request.POST.get('commission_type'),
            'created_at':      raw_date
        }

        bank_id = request.POST.get('details')
        bank_instance = None
        if bank_id:
            bank_instance = BankDetail.objects.filter(id=bank_id, is_deleted=False).first()

        # 2. Очищаем числа перед сохранением в БД (полная точность, без обрезки)
        price_val      = safe_decimal(request.POST.get('price'))
        amount_val     = safe_decimal(request.POST.get('amount'))
        cost_val       = safe_decimal(request.POST.get('cost'))
        commission_val = safe_decimal(request.POST.get('commission_value'))

        # 3. Определяем процент биржи
        exchange_name  = request.POST.get('exchange', '').lower()
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

        external_id = request.POST.get('external_id')

        # 4. Создаём ордер (в БД храним полные значения без обрезки)
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
            exchange_commission_rate=user_comm_rate,
            screenshot=request.FILES.get('screenshot'),
            created_at=order_date
        )

        # 5. Удаляем из необработанных
        if external_id:
            UnprocessedOrder.objects.filter(
                user=request.user,
                order_id=external_id
            ).delete()

        # 6. Логика чека (Эвотор)
        need_receipt = request.POST.get('need_receipt') == 'on'

        if need_receipt:
            contact_email = request.POST.get('receipt_contact')
            if not contact_email:
                contact_email = request.user.email

            # Эвотор не принимает больше 3 знаков после запятой.
            # ОБРЕЗАЕМ (не округляем) только для чека — в БД данные полные.
            # Пример: 86.3429 -> 86.342  |  523.1239 -> 523.123
            receipt_data = {
                "contact": contact_email,
                "sum":    truncate(order.cost,   3),
                "price":  truncate(order.price,  3),
                "amount": truncate(order.amount, 3),
            }

            create_or_update_and_send_receipt(order, receipt_data)

        return redirect('my_orders')

    orders = Order.objects.filter(user=request.user).order_by('-created_at')

    # Достаём сохранённые настройки формы
    saved_data = request.session.get('saved_order_form', {})

    if not saved_data:
        saved_data = {
            'operation_type':  'BUY',
            'exchange':        'Bybit',
            'commission_type': 'PERCENT'
        }

    if saved_data.get('created_at'):
        current_time = saved_data['created_at']
    else:
        current_time = timezone.now().strftime('%Y-%m-%dT%H:%M')

    return render(request, 'orders/my_orders.html', {
        'orders':        orders,
        'default_banks': default_banks,
        'current_time':  current_time,
        'saved_data':    saved_data
    })


@login_required
def edit_order(request, order_id):
    order = get_object_or_404(Order, id=order_id, user=request.user)
    
    if request.method == 'POST':
        # 1. Обработка банка (ищем по ID, как и при создании)
        # 1. Обработка банка
        bank_id_or_name = request.POST.get('details')
        if bank_id_or_name:
            if bank_id_or_name.isdigit():
                # Если пришло число (ID)
                bank_instance = BankDetail.objects.filter(id=bank_id_or_name, is_deleted=False).first()
            else:
                # Если пришла строка (Название)
                bank_instance = BankDetail.objects.filter(name=bank_id_or_name, is_deleted=False).first()
            
            if bank_instance:
                order.bank_detail = bank_instance

        order.external_id = request.POST.get('external_id')
        
        # 2. Обязательно используем safe_decimal для чисел!
        order.price = safe_decimal(request.POST.get('price'))
        order.amount = safe_decimal(request.POST.get('amount'))
        order.cost = safe_decimal(request.POST.get('cost'))
        order.commission = safe_decimal(request.POST.get('commission_value'))
        
        order.operation_type = request.POST.get('operation_type')
        order.exchange_type = request.POST.get('exchange')
        order.commission_type = request.POST.get('commission_type')
        
        # 3. ИСПРАВЛЕНИЕ ОШИБОК ДАТЫ (AttributeError и RuntimeWarning)
        raw_date = request.POST.get('created_at')
        if raw_date:
            # Убрано лишнее .datetime
            naive_date = datetime.strptime(raw_date, '%Y-%m-%dT%H:%M')
            # Добавлена привязка к таймзоне
            order.created_at = timezone.make_aware(naive_date)

        order.save()
        return redirect('my_orders')

    # Если есть логика для GET запроса (рендер страницы редактирования), она остается тут
    

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
    user = request.user
    bybit_ok = bool(user.bybit_api_key and user.bybit_api_secret)
    mexc_ok  = bool(
        getattr(user, 'mexc_api_key', None) and getattr(user, 'mexc_api_secret', None)
    )

    if not bybit_ok and not mexc_ok:
        messages.warning(request, "API ключи не настроены. Зайди в настройки.")

    unprocessed_orders = (
        UnprocessedOrder.objects
        .filter(user=user)
        .order_by('-created_at')
    )

    context = {
        'unprocessed_orders': unprocessed_orders,
        'bybit_configured':   bybit_ok,
        'mexc_configured':    mexc_ok,
    }
    return render(request, 'orders/unprocessed.html', context)

@login_required
def delete_unprocessed_order(request, pk):
    """
    Удаляет ордер из буфера необработанных И навсегда добавляет в игнор,
    чтобы синхронизация с биржи больше никогда его не подтягивала.
    """
    try:
        order = UnprocessedOrder.objects.get(pk=pk, user=request.user)

        # Добавляем в игнор (get_or_create — защита от дублей)
        IgnoredOrder.objects.get_or_create(
            user=request.user,
            order_id=order.order_id,
            defaults={"exchange_type": order.exchange_type},
        )

        order.delete()
        messages.success(request, "Ордер удалён и добавлен в игнор-лист.")

    except UnprocessedOrder.DoesNotExist:
        messages.error(request, "Ордер не найден.")

    return redirect("unprocessed_orders")



import json as _json
from datetime import timezone as dt_timezone

SYSTEM_START = datetime(2026, 2, 1, 0, 0, 0, tzinfo=dt_timezone.utc)


def _calc_month_profit_for_user(user, month_start, month_end):
    """
    Та же функция что у админа — гарантирует совпадение цифр.

    remainder_qty_display — для показа (может быть отрицательным)
    remainder_qty_calc    — для расчётов (>= 0, иначе прибыль искажается)
    """
    # --- Переходящий остаток ---
    prev_orders = Order.objects.filter(
        user=user,
        created_at__gte=SYSTEM_START,
        created_at__lt=month_start
    ).order_by('created_at')

    prev_buy_qty    = 0.0
    prev_buy_cost   = 0.0
    prev_sell_qty   = 0.0
    prev_exch_usdt  = 0.0
    prev_last_price = 0.0

    for o in prev_orders:
        amt = float(o.amount or 0)
        if o.operation_type == 'BUY':
            prev_buy_qty    += amt
            prev_buy_cost   += float(o.cost or 0)
            prev_last_price  = float(o.price or 0)
        else:
            exch_rate = float(o.exchange_commission_rate or 0)
            prev_sell_qty   += amt
            prev_exch_usdt  += amt * exch_rate / 100

    prev_balance_qty  = prev_buy_qty - prev_sell_qty - prev_exch_usdt
    prev_balance_cost = prev_balance_qty * prev_last_price

    # --- Ордера текущего месяца ---
    month_orders = Order.objects.filter(
        user=user,
        created_at__gte=month_start,
        created_at__lt=month_end
    ).order_by('created_at')

    month_buy_qty    = 0.0; month_buy_cost   = 0.0
    month_buy_comm   = 0.0
    month_sell_qty   = 0.0; month_sell_cost  = 0.0
    month_sell_comm  = 0.0
    month_exch_usdt  = 0.0
    month_last_price = prev_last_price

    for o in month_orders:
        amt        = float(o.amount or 0)
        cost       = float(o.cost   or 0)
        price      = float(o.price  or 0)
        comm_val   = float(o.commission or 0)
        total_comm = cost * comm_val / 100 if o.commission_type == 'PERCENT' else comm_val

        if o.operation_type == 'BUY':
            month_buy_qty    += amt
            month_buy_cost   += cost
            month_buy_comm   += total_comm
            month_last_price  = price
        else:
            exch_rate = float(o.exchange_commission_rate or 0)
            month_sell_qty   += amt
            month_sell_cost  += cost
            month_sell_comm  += total_comm
            month_exch_usdt  += amt * exch_rate / 100

    total_buy_qty  = prev_balance_qty  + month_buy_qty
    total_buy_cost = prev_balance_cost + month_buy_cost

    # Остаток для отображения — может быть отрицательным
    remainder_qty_display = total_buy_qty - month_sell_qty - month_exch_usdt
    # Остаток для расчётов — не уходит в минус
    remainder_qty_calc    = max(0.0, remainder_qty_display)
    remainder_cost        = remainder_qty_calc * month_last_price

    eq_buy_cost = total_buy_cost - remainder_cost

    if month_sell_qty == 0:
        gross = 0.0
    else:
        gross = month_sell_cost - eq_buy_cost - month_buy_comm - month_sell_comm

    return {
        'prev_balance_qty':      prev_balance_qty,
        'prev_balance_cost':     prev_balance_cost,
        'month_buy_qty':         month_buy_qty,
        'month_buy_cost':        month_buy_cost,
        'month_buy_comm':        month_buy_comm,
        'month_sell_qty':        month_sell_qty,
        'month_sell_cost':       month_sell_cost,
        'month_sell_comm':       month_sell_comm,
        'month_exch_usdt':       month_exch_usdt,
        'total_buy_qty':         total_buy_qty,
        'total_buy_cost':        total_buy_cost,
        'remainder_qty_display': remainder_qty_display,
        'remainder_qty_calc':    remainder_qty_calc,
        'remainder_cost':        remainder_cost,
        'eq_buy_cost':           eq_buy_cost,
        'gross':                 gross,
    }


def _calc_today_profit(user, period_start, period_end):
    """Расчёт за произвольный период (для вкладки 'Сегодня')."""
    from zoneinfo import ZoneInfo
    MSK = ZoneInfo('Europe/Moscow')
    month_start = datetime(period_start.year, period_start.month, 1, tzinfo=MSK)

    prev_orders = Order.objects.filter(
        user=user,
        created_at__gte=SYSTEM_START,
        created_at__lt=month_start
    ).order_by('created_at')

    prev_buy_qty    = 0.0
    prev_buy_cost   = 0.0
    prev_sell_qty   = 0.0
    prev_exch_usdt  = 0.0
    prev_last_price = 0.0

    for o in prev_orders:
        amt = float(o.amount or 0)
        if o.operation_type == 'BUY':
            prev_buy_qty    += amt
            prev_buy_cost   += float(o.cost or 0)
            prev_last_price  = float(o.price or 0)
        else:
            exch_rate = float(o.exchange_commission_rate or 0)
            prev_sell_qty   += amt
            prev_exch_usdt  += amt * exch_rate / 100

    prev_balance_qty  = prev_buy_qty - prev_sell_qty - prev_exch_usdt
    prev_balance_cost = prev_balance_qty * prev_last_price

    period_orders = Order.objects.filter(
        user=user,
        created_at__gte=month_start,
        created_at__lt=period_end
    ).order_by('created_at')

    buy_qty    = 0.0; buy_cost   = 0.0; buy_comm   = 0.0
    sell_qty   = 0.0; sell_cost  = 0.0; sell_comm  = 0.0
    exch_usdt  = 0.0
    last_price = prev_last_price

    for o in period_orders:
        amt        = float(o.amount or 0)
        cost       = float(o.cost   or 0)
        price      = float(o.price  or 0)
        comm_val   = float(o.commission or 0)
        total_comm = cost * comm_val / 100 if o.commission_type == 'PERCENT' else comm_val

        if o.operation_type == 'BUY':
            buy_qty    += amt
            buy_cost   += cost
            buy_comm   += total_comm
            last_price  = price
        else:
            exch_rate  = float(o.exchange_commission_rate or 0)
            sell_qty   += amt
            sell_cost  += cost
            sell_comm  += total_comm
            exch_usdt  += amt * exch_rate / 100

    total_buy_qty  = prev_balance_qty  + buy_qty
    total_buy_cost = prev_balance_cost + buy_cost

    remainder_qty_display = total_buy_qty - sell_qty - exch_usdt
    remainder_qty_calc    = max(0.0, remainder_qty_display)
    remainder_cost        = remainder_qty_calc * last_price
    eq_buy_cost           = total_buy_cost - remainder_cost

    if sell_qty == 0:
        gross = 0.0
    else:
        gross = sell_cost - eq_buy_cost - buy_comm - sell_comm

    return {
        'prev_balance_qty':      prev_balance_qty,
        'prev_balance_cost':     prev_balance_cost,
        'buy_qty':               buy_qty,
        'buy_cost':              buy_cost,
        'buy_comm':              buy_comm,
        'sell_qty':              sell_qty,
        'sell_cost':             sell_cost,
        'sell_comm':             sell_comm,
        'exch_usdt':             exch_usdt,
        'total_buy_qty':         total_buy_qty,
        'total_buy_cost':        total_buy_cost,
        'remainder_qty_display': remainder_qty_display,
        'remainder_qty_calc':    remainder_qty_calc,
        'remainder_cost':        remainder_cost,
        'eq_buy_cost':           eq_buy_cost,
        'gross':                 gross,
    }


@login_required
def user_profit_view(request):
    """
    Страница аналитики прибыли пользователя.

    Вкладка 'Сегодня':   _calc_today_profit
    Вкладка 'По месяцам': _calc_month_profit_for_user (та же что у админа)

    Остаток:
      - crypto_balance (карточка) = all_buy - all_sell - all_exch_comm
      - remainder_qty (месяц)     = показывает отрицательный если продали больше
    """
    action = request.GET.get('action')

    # =====================================================================
    # РАСХОДЫ
    # =====================================================================
    if action == 'get_expenses':
        expenses = UserExpense.objects.filter(user=request.user).order_by('-month', 'name')
        return JsonResponse({'expenses': [
            {'id': e.id, 'name': e.name, 'amount': float(e.amount), 'month': e.month}
            for e in expenses
        ]})

    if action == 'add_expense':
        try:
            body   = _json.loads(request.body)
            name   = str(body.get('name', '')).strip()
            amount = float(body.get('amount', 0))
            month  = str(body.get('month', ''))
            if not name or amount <= 0 or not month:
                return JsonResponse({'error': 'Некорректные данные'}, status=400)
            UserExpense.objects.create(user=request.user, name=name, amount=amount, month=month)
            return JsonResponse({'ok': True})
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=400)

    if action == 'delete_expense':
        try:
            body   = _json.loads(request.body)
            exp_id = int(body.get('id', 0))
            UserExpense.objects.filter(id=exp_id, user=request.user).delete()
            return JsonResponse({'ok': True})
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=400)

    # =====================================================================
    # РАСЧЁТ ПО МЕСЯЦАМ
    # =====================================================================
    if action == 'get_months':
        user = request.user

        from zoneinfo import ZoneInfo
        MSK = ZoneInfo('Europe/Moscow')

        all_orders = Order.objects.filter(
            user=user,
            created_at__gte=SYSTEM_START
        ).order_by('created_at')

        months_with_orders = set()
        for o in all_orders:
            # Переводим в МСК для определения месяца
            dt_msk = o.created_at.astimezone(MSK)
            months_with_orders.add((dt_msk.year, dt_msk.month))

        if not months_with_orders:
            return JsonResponse({'months': []})

        user_shares = user.profit_shares if isinstance(user.profit_shares, dict) else {}

        months_data = []
        for (yr, mo) in sorted(months_with_orders):
            month_start = datetime(yr, mo, 1, tzinfo=MSK)
            month_end   = datetime(yr + 1, 1, 1, tzinfo=MSK) if mo == 12 else datetime(yr, mo + 1, 1, tzinfo=MSK)
            share_key   = f"{yr}-{str(mo).zfill(2)}"

            # Та же функция что у админа
            calc  = _calc_month_profit_for_user(user, month_start, month_end)
            gross = calc['gross']

            taxable    = max(0.0, gross - month_expenses)
            ndfl       = taxable * 0.13 if taxable > 0 else 0
            after_ndfl = taxable - ndfl

            share_percent = float(user_shares.get(share_key, 20.0))
            share_amount  = after_ndfl * (share_percent / 100) if after_ndfl > 0 else 0

            month_expenses = float(
                UserExpense.objects.filter(user=user, month=share_key)
                .aggregate(Sum('amount'))['amount__sum'] or 0
            )

            net_profit = after_ndfl - share_amount

            months_data.append({
                'key':               share_key,
                'year':              yr,
                'month':             mo,
                'prev_balance_qty':  round(calc['prev_balance_qty'],       2),
                'prev_balance_cost': round(calc['prev_balance_cost'],      2),
                'buy_qty':           round(calc['month_buy_qty'],          2),
                'buy_cost':          round(calc['month_buy_cost'],         2),
                'sell_qty':          round(calc['month_sell_qty'],         2),
                'sell_cost':         round(calc['month_sell_cost'],        2),
                'total_buy_qty':     round(calc['total_buy_qty'],          2),
                'total_buy_cost':    round(calc['total_buy_cost'],         2),
                # Остаток для отображения (может быть отрицательным)
                'remainder_qty':     round(calc['remainder_qty_display'],  2),
                'remainder_cost':    round(calc['remainder_cost'],         2),
                'eq_buy_cost':       round(calc['eq_buy_cost'],            2),
                'buy_comm':          round(calc['month_buy_comm'],         2),
                'sell_comm':         round(calc['month_sell_comm'],        2),
                'exch_usdt':         round(calc['month_exch_usdt'],        2),
                'gross':             round(gross,          2),
                'ndfl':              round(ndfl,           2),
                'after_ndfl':        round(after_ndfl,     2),
                'share_percent':     share_percent,
                'share_amount':      round(share_amount,   2),
                'month_expenses':    round(month_expenses, 2),
                'net_profit':        round(net_profit,     2),
            })

        return JsonResponse({'months': months_data})

    # =====================================================================
    # РАСЧЁТ ЗА ПЕРИОД — для вкладки "Сегодня"
    # =====================================================================
    if action == 'get_turnover':
        user           = request.user
        start_date_str = request.GET.get('start')
        end_date_str   = request.GET.get('end')
        exchange       = request.GET.get('exchange')
        bank_id        = request.GET.get('bank')

        if start_date_str and end_date_str:
            try:
                naive_start  = datetime.strptime(start_date_str, '%Y-%m-%d')
                naive_end    = datetime.strptime(end_date_str,   '%Y-%m-%d')
                naive_end    = naive_end.replace(hour=23, minute=59, second=59)
                period_start = timezone.make_aware(naive_start)
                period_end   = timezone.make_aware(naive_end)
            except ValueError:
                return JsonResponse({'error': 'Неверный формат даты'}, status=400)
        else:
            period_start = timezone.now()
            period_end   = timezone.now()

        calc  = _calc_today_profit(user, period_start, period_end)
        gross = calc['gross']

        month_key     = f"{period_start.year}-{str(period_start.month).zfill(2)}"
        user_shares   = user.profit_shares if isinstance(user.profit_shares, dict) else {}
        share_percent = float(user_shares.get(month_key, 20.0))

        month_expenses = float(
            UserExpense.objects.filter(user=user, month=month_key)
            .aggregate(Sum('amount'))['amount__sum'] or 0
        )
        taxable    = max(0.0, gross - month_expenses)
        ndfl       = taxable * 0.13 if taxable > 0 else 0
        after_ndfl = taxable - ndfl
        share_amount  = after_ndfl * (share_percent / 100) if after_ndfl > 0 else 0
        net_profit = after_ndfl - share_amount

        # Текущий глобальный остаток = all_buy - all_sell - all_exch_comm
        all_orders_sell = Order.objects.filter(
            user=user, created_at__gte=SYSTEM_START, operation_type='SELL'
        )
        all_buy  = float(Order.objects.filter(user=user, created_at__gte=SYSTEM_START, operation_type='BUY').aggregate(Sum('amount'))['amount__sum'] or 0)
        all_sell = float(all_orders_sell.aggregate(Sum('amount'))['amount__sum'] or 0)
        all_exch_comm = sum(
            float(o.amount or 0) * float(o.exchange_commission_rate or 0) / 100
            for o in all_orders_sell
        )
        # Отображаем с минусом если продали больше чем купили
        crypto_balance = all_buy - all_sell - all_exch_comm

        period_orders = Order.objects.filter(
            user=user,
            created_at__gte=SYSTEM_START,
            created_at__range=(period_start, period_end)
        )
        if exchange:
            period_orders = period_orders.filter(exchange_type__icontains=exchange)
        if bank_id:
            period_orders = period_orders.filter(bank_detail_id=bank_id)

        buy_orders  = period_orders.filter(operation_type='BUY').order_by('-created_at')
        sell_orders = period_orders.filter(operation_type='SELL').order_by('-created_at')

        buy_sum  = float(buy_orders.aggregate(Sum('cost'))['cost__sum'] or 0)
        sell_sum = float(sell_orders.aggregate(Sum('cost'))['cost__sum'] or 0)

        period_buy_crypto  = float(buy_orders.aggregate(Sum('amount'))['amount__sum'] or 0)
        period_sell_crypto = float(sell_orders.aggregate(Sum('amount'))['amount__sum'] or 0)
        crypto_delta       = period_buy_crypto - period_sell_crypto

        def serialize(qs, is_sell=False):
            res = []
            for o in qs:
                display_id = o.external_id if o.external_id else str(o.id)
                comm_val   = float(o.commission or 0)
                bank_comm  = float(o.cost or 0) * comm_val / 100 if o.commission_type == 'PERCENT' else comm_val
                exch_comm  = float(o.amount or 0) * float(o.exchange_commission_rate or 0) / 100 if is_sell else 0.0
                res.append({
                    'id':            o.id,
                    'external_id':   display_id,
                    'price':         float(o.price  or 0),
                    'amount':        float(o.amount or 0),
                    'cost':          float(o.cost   or 0),
                    'date':          o.created_at.strftime('%d.%m.%Y %H:%M'),
                    'exchange':      getattr(o, 'exchange_type', ''),
                    'bank':          str(o.bank_detail) if o.bank_detail else '',
                    'bank_comm':     round(bank_comm, 2),
                    'exchange_comm': round(exch_comm, 2),
                })
            return res

        return JsonResponse({
            'buy_sum':            buy_sum,
            'buy_count':          buy_orders.count(),
            'sell_sum':           sell_sum,
            'sell_count':         sell_orders.count(),
            'prev_balance_qty':   round(calc['prev_balance_qty'],       2),
            'prev_balance_cost':  round(calc['prev_balance_cost'],      2),
            'total_buy_qty':      round(calc['total_buy_qty'],          2),
            'total_buy_cost':     round(calc['total_buy_cost'],         2),
            'remainder_qty':      round(calc['remainder_qty_display'],  2),
            'remainder_cost':     round(calc['remainder_cost'],         2),
            'eq_buy_cost':        round(calc['eq_buy_cost'],            2),
            'gross':              round(gross,         2),
            'ndfl':               round(ndfl,          2),
            'after_ndfl':         round(after_ndfl,    2),
            'share_percent':      share_percent,
            'share_amount':       round(share_amount,  2),
            'month_expenses':     round(month_expenses, 2),
            'net_profit':         round(net_profit,    2),
            'crypto_balance':     round(crypto_balance, 2),
            'crypto_delta':       round(crypto_delta,   2),
            'buy_orders':         serialize(buy_orders,  is_sell=False),
            'sell_orders':        serialize(sell_orders, is_sell=True),
            'user_shares':        user_shares,
        })

    default_banks = BankDetail.objects.filter(is_deleted=False)
    return render(request, 'orders/profit.html', {'default_banks': default_banks})


# --- АДМИН ПАНЕЛЬ ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_users_list(request):
    """Список пользователей и управление ими"""
    if not request.user.is_superuser:
        return redirect('admin_login')

    # === 1. Редактирование пользователя ===
    if request.method == 'POST' and request.POST.get('action') == 'edit_user':
        user_id = request.POST.get('user_id')
        try:
            user_to_edit = User.objects.get(id=user_id)

            new_username = request.POST.get('username')
            if new_username:
                user_to_edit.username = new_username

            new_password = request.POST.get('password')
            if new_password:
                user_to_edit.set_password(new_password)

            user_to_edit.bybit_api_key    = request.POST.get('bybit_key')
            user_to_edit.bybit_api_secret = request.POST.get('bybit_secret')
            user_to_edit.htx_access_key   = request.POST.get('htx_key')
            user_to_edit.htx_private_key  = request.POST.get('htx_secret')
            user_to_edit.mexc_api_key     = request.POST.get('mexc_key')
            user_to_edit.mexc_api_secret  = request.POST.get('mexc_secret')
            user_to_edit.evotor_login     = request.POST.get('evotor_login')
            user_to_edit.evotor_password  = request.POST.get('evotor_password')

            user_to_edit.save()
            messages.success(request, f"Пользователь {user_to_edit.username} успешно обновлен.")
        except User.DoesNotExist:
            messages.error(request, "Пользователь не найден.")

        return redirect('admin_users')

    # === 2. Создание пользователя ===
    if request.method == 'POST' and request.POST.get('action') == 'create_user':
        username = request.POST.get('username')
        password = request.POST.get('password')
        if username and password:
            User.objects.create(
                username=username,
                password=make_password(password),
                bybit_api_key=request.POST.get('bybit_key'),
                bybit_api_secret=request.POST.get('bybit_secret'),
                is_staff=True
            )
            messages.success(request, f"Пользователь {username} создан.")
        return redirect('admin_users')

    # === 3. Корректировка начального остатка ===
    # Создаёт или обновляет один специальный BUY-ордер
    # с exchange_type="Остаток (до 1 фев)" датой 01.02.2026.
    # Этот ордер автоматически учитывается в FIFO-расчёте прибыли
    # в user_profit_view как обычная покупка.
    if request.method == 'POST' and request.POST.get('action') == 'edit_balance':
        user_id        = request.POST.get('user_id')
        adjustment_str = request.POST.get('balance_adjustment', '0')
        rate_str       = request.POST.get('balance_rate', '0')

        try:
            user_to_edit = User.objects.get(id=user_id)

            amount_val = float(str(adjustment_str).replace(',', '.'))
            rate_val   = float(str(rate_str).replace(',', '.'))

            # Ищем существующий исторический ордер этого пользователя
            init_order = Order.objects.filter(
                user=user_to_edit,
                exchange_type="Остаток (до 1 фев)"
            ).first()

            if amount_val == 0:
                # Ввели 0 — удаляем исторический ордер
                if init_order:
                    init_order.delete()
                messages.success(
                    request,
                    f"Начальный остаток пользователя {user_to_edit.username} удалён."
                )
            else:
                if rate_val <= 0:
                    messages.error(request, "Укажите курс закупки больше нуля.")
                    return redirect('admin_users')

                op_type    = 'BUY' if amount_val > 0 else 'SELL'
                abs_amount = abs(amount_val)
                cost       = abs_amount * rate_val

                if init_order:
                    # Ордер уже есть — обновляем
                    init_order.operation_type = op_type
                    init_order.amount         = abs_amount
                    init_order.price          = rate_val
                    init_order.cost           = cost
                    init_order.save()
                    messages.success(
                        request,
                        f"Начальный остаток пользователя {user_to_edit.username} "
                        f"изменён: {amount_val} USDT по курсу {rate_val} ₽ "
                        f"(= {cost:,.2f} ₽)."
                    )
                else:
                    # Ордера нет — создаём новый датой 01.02.2026 00:00
                    feb_first = datetime(2026, 2, 1, 0, 0, 0, tzinfo=dt_timezone.utc)
                    Order.objects.create(
                        user=user_to_edit,
                        external_id=f"INIT-{user_to_edit.id}",
                        operation_type=op_type,
                        amount=abs_amount,
                        price=rate_val,
                        cost=cost,
                        exchange_type="Остаток (до 1 фев)",
                        created_at=feb_first
                    )
                    messages.success(
                        request,
                        f"Начальный остаток внесён для {user_to_edit.username}: "
                        f"{amount_val} USDT по курсу {rate_val} ₽ "
                        f"(= {cost:,.2f} ₽)."
                    )

        except User.DoesNotExist:
            messages.error(request, "Пользователь не найден.")
        except ValueError:
            messages.error(request, "Некорректное значение количества или курса.")

        return redirect('admin_users')

    # === 4. Настройка доли пользователя по месяцам ===
    if request.method == 'POST' and request.POST.get('action') == 'edit_share':
        user_id = request.POST.get('user_id')
        year    = request.POST.get('share_year')

        try:
            user_to_edit = User.objects.get(id=user_id)

            # Инициализируем словарь если он пустой или некорректный
            if not isinstance(user_to_edit.profit_shares, dict):
                user_to_edit.profit_shares = {}

            # Собираем доли за все 12 месяцев из формы
            # Ключ: '2026-01', '2026-02' и т.д.
            for i in range(1, 13):
                month_str = f"{i:02d}"
                key       = f"{year}-{month_str}"
                val       = request.POST.get(f"share_{month_str}")

                if val is not None and val.strip() != "":
                    user_to_edit.profit_shares[key] = float(str(val).replace(',', '.'))

            user_to_edit.save()
            messages.success(
                request,
                f"Доля для пользователя {user_to_edit.username} обновлена на {year} год."
            )
        except User.DoesNotExist:
            messages.error(request, "Пользователь не найден.")
        except ValueError:
            messages.error(request, "Ошибка в формате числа доли. Используйте цифры.")

        return redirect('admin_users')

    # === 5. Вывод списка пользователей ===
    users = User.objects.all().order_by('id')

    for u in users:
        bought = float(
            Order.objects.filter(user=u, operation_type='BUY')
            .aggregate(Sum('amount'))['amount__sum'] or 0
        )
        sold = float(
            Order.objects.filter(user=u, operation_type='SELL')
            .aggregate(Sum('amount'))['amount__sum'] or 0
        )

        # Реальный баланс = все BUY (включая "Остаток (до 1 фев)") минус все SELL.
        # initial_crypto_balance НЕ прибавляем — остаток живёт как ордер.
        u.real_balance = bought - sold

        # Данные исторического ордера для модалки корректировки
        init_order = Order.objects.filter(
            user=u,
            exchange_type="Остаток (до 1 фев)"
        ).first()

        if init_order:
            u.has_initial_balance = True
            u.init_amount = (
                float(init_order.amount)
                if init_order.operation_type == 'BUY'
                else -float(init_order.amount)
            )
            u.init_rate = float(init_order.price)
        else:
            u.has_initial_balance = False
            u.init_amount = 0
            u.init_rate   = 0

        # JSON долей — передаём в атрибут HTML-кнопки для модалки
        u.shares_json = json.dumps(u.profit_shares) if u.profit_shares else "{}"

    return render(request, 'custom_admin/users_list.html', {'users': users})



def _month_name(n):
    return ["Январь","Февраль","Март","Апрель","Май","Июнь",
            "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"][n - 1]


@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def export_excel_report(request):
    """
    Экспорт отчёта в Excel по логике КУДиР.

    Торговый результат включает остаток с предыдущего месяца:
      data_start фиксируется ДО строки переноса остатка —
      чтобы SUM диапазон захватывал строку переноса.

    Остаток = =E{tr}-I{tr}-M{tr}
      (BUY включая перенос) - (SELL) - (комса биржи USDT)

    Себестоимость остатка = =E{ost}*F{ost}
    Реализованный = G{tr} - G{ost}
    Прибыль = K{rr} - G{rr} - H{tr} - L{tr}

    Все даты и группировка по месяцам — в МСК (Europe/Moscow),
    чтобы совпадать с логикой админки и пользовательской страницы прибыли.
    """
    user_id    = request.GET.get('user_id')
    start_date = request.GET.get('start')
    end_date   = request.GET.get('end')
    bank_id    = request.GET.get('bank_id')
    op_type    = request.GET.get('type')

    SYSTEM_START = datetime(2026, 2, 1, 0, 0, 0, tzinfo=dt_timezone.utc)

    orders = Order.objects.filter(
        user_id=user_id,
        created_at__gte=SYSTEM_START
    ).order_by('created_at')

    if start_date: orders = orders.filter(created_at__date__gte=start_date)
    if end_date:   orders = orders.filter(created_at__date__lte=end_date)
    if bank_id and bank_id.isdigit(): orders = orders.filter(bank_detail_id=bank_id)
    if op_type:    orders = orders.filter(operation_type=op_type)

    orders_list = list(orders)

    # Исторический ордер — всегда первый
    init_order = Order.objects.filter(
        user_id=user_id,
        exchange_type="Остаток (до 1 фев)"
    ).first()

    if init_order:
        existing_ids = {o.id for o in orders_list}
        if init_order.id not in existing_ids:
            orders_list = [init_order] + orders_list

    # Группировка по месяцам в МСК — совпадает с логикой админки
    months_in_period = set()
    for o in orders_list:
        dt_msk = o.created_at.astimezone(MSK)
        months_in_period.add((dt_msk.year, dt_msk.month))
    multi_month = len(months_in_period) > 1

    # =====================================================================
    # Книга и стили
    # =====================================================================
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Отчет"

    thin_border  = Border(left=Side(style='thin'), right=Side(style='thin'),
                          top=Side(style='thin'),  bottom=Side(style='thin'))
    bold_font    = Font(bold=True)
    center_align = Alignment(horizontal='center', vertical='center', wrap_text=True)
    left_align   = Alignment(horizontal='left', vertical='center', wrap_text=True)

    ws.merge_cells('A1:M1')
    ws['A1'] = "Учет приобретенной и проданной цифровой валюты (ЦВ)"
    ws['A1'].font      = Font(size=14, bold=True)
    ws['A1'].alignment = Alignment(horizontal='center')

    ws.merge_cells('A2:A3'); ws['A2'] = "№ п/п"
    ws.merge_cells('B2:B3'); ws['B2'] = "Дата операции"
    ws.merge_cells('C2:C3'); ws['C2'] = "Номер документа"
    ws.merge_cells('D2:D3'); ws['D2'] = "Наименование ЦВ"
    ws.merge_cells('E2:H2'); ws['E2'] = "Приобретение цифровой валюты"
    ws.merge_cells('I2:M2'); ws['I2'] = "Продажа цифровой валюты"

    ws.append([
        "", "", "", "",
        "Кол-во", "Курс", "Стоимость", "Комиссия банка",
        "Кол-во", "Курс", "Стоимость", "Комиссия банка", "Комиссия биржи (USDT)"
    ])

    for row in ws.iter_rows(min_row=1, max_row=3, min_col=1, max_col=13):
        for cell in row:
            cell.font      = bold_font
            cell.alignment = center_align
            cell.border    = thin_border

    # =====================================================================
    # Запись строки ордера
    # =====================================================================
    def write_order_row(o, idx, is_historical=False):
        row_num    = ws.max_row + 1
        comm_val   = float(o.commission or 0)
        total_comm = float(o.cost) * comm_val / 100 if o.commission_type == 'PERCENT' else comm_val
        amount_f   = float(o.amount or 0)
        price_f    = float(o.price  or 0)
        exch_rate  = float(o.exchange_commission_rate or 0)

        # Дата в МСК — совпадает с группировкой по месяцам
        if is_historical:
            label = "-"
        elif o.created_at:
            label = o.created_at.astimezone(MSK).strftime('%d.%m.%Y')
        else:
            label = ""

        num = 0 if is_historical else idx

        if o.operation_type == 'BUY':
            ws.append([
                num, label, o.external_id, "USDT",
                amount_f,
                price_f,
                f"=E{row_num}*F{row_num}",
                total_comm if total_comm > 0 else 0,
                0, 0, 0, 0, 0
            ])
        else:
            exch_comm_usdt = amount_f * exch_rate / 100
            ws.append([
                num, label, o.external_id, "USDT",
                0, 0, 0, 0,
                amount_f,
                price_f,
                f"=I{row_num}*J{row_num}",
                total_comm if total_comm > 0 else 0,
                exch_comm_usdt if exch_rate > 0 else 0
            ])

    # =====================================================================
    # Перенос остатка предыдущего месяца
    # =====================================================================
    def write_carry_row(label, prev_ost_row):
        ws.append([
            0, "-", label, "USDT",
            f"=E{prev_ost_row}",
            f"=F{prev_ost_row}",
            f"=G{prev_ost_row}",
            0,
            0, 0, 0, 0, 0
        ])

    # =====================================================================
    # Итоговые строки после блока ордеров
    # =====================================================================
    def write_summary(label_suffix, data_start, data_end, last_buy_price):
        ws.append([])  # разделитель

        tr = ws.max_row + 1
        ws.append([
            f"Торговый результат{label_suffix}:", "", "", "",
            f"=SUM(E{data_start}:E{data_end})",
            "",
            f"=SUM(G{data_start}:G{data_end})",
            f"=SUM(H{data_start}:H{data_end})",
            f"=SUM(I{data_start}:I{data_end})",
            "",
            f"=SUM(K{data_start}:K{data_end})",
            f"=SUM(L{data_start}:L{data_end})",
            f"=SUM(M{data_start}:M{data_end})",
        ])
        tr = ws.max_row

        ost = ws.max_row + 1
        ws.append([
            f"Остаток (нереализованная ЦВ){label_suffix}:", "", "", "",
            f"=E{tr}-I{tr}-M{tr}",
            last_buy_price,
            f"=E{ost}*F{ost}",
            0, "", "", "", "", ""
        ])
        ost = ws.max_row

        rr = ws.max_row + 1
        ws.append([
            f"Реализованный результат{label_suffix}:", "", "", "",
            f"=I{tr}",
            "",
            f"=G{tr}-G{ost}",
            "",
            f"=I{tr}",
            "",
            f"=K{tr}",
            "", ""
        ])
        rr = ws.max_row

        ws.append([
            f"Прибыль{label_suffix}:", "", "", "",
            f"=K{rr}-G{rr}-H{tr}-L{tr}",
            "", "", "", "", "", "", "", ""
        ])

        ws.append([])  # разделитель

        return ost

    # =====================================================================
    # Обход ордеров — группировка по МСК месяцам
    # =====================================================================
    idx            = 0
    last_buy_price = 0.0
    prev_ost_row   = None

    # Ключ группировки — по МСК времени
    def get_month_key(o):
        dt_msk = o.created_at.astimezone(MSK)
        return (dt_msk.year, dt_msk.month)

    if multi_month:
        is_first_month = True

        for (yr, mo), month_orders in _groupby(orders_list, key=get_month_key):
            month_list = list(month_orders)

            # data_start фиксируем ДО строки переноса
            data_start = ws.max_row + 1

            if not is_first_month and prev_ost_row is not None:
                carry_label = f"Остаток с {_month_name(mo - 1 if mo > 1 else 12)} {yr if mo > 1 else yr - 1}"
                write_carry_row(carry_label, prev_ost_row)

            for o in month_list:
                is_hist = o.exchange_type == "Остаток (до 1 фев)"
                price_f = float(o.price or 0)

                if not is_hist:
                    idx += 1

                write_order_row(o, idx if not is_hist else 0, is_historical=is_hist)

                if o.operation_type == 'BUY':
                    last_buy_price = price_f

            data_end     = ws.max_row
            prev_ost_row = write_summary(
                f" за {_month_name(mo)} {yr}",
                data_start, data_end,
                last_buy_price
            )
            is_first_month = False

    else:
        data_start = ws.max_row + 1

        for o in orders_list:
            is_hist = o.exchange_type == "Остаток (до 1 фев)"
            price_f = float(o.price or 0)

            if not is_hist:
                idx += 1

            write_order_row(o, idx if not is_hist else 0, is_historical=is_hist)

            if o.operation_type == 'BUY':
                last_buy_price = price_f

        data_end = ws.max_row
        write_summary("", data_start, data_end, last_buy_price)

    # =====================================================================
    # Оформление
    # =====================================================================
    summary_kw = ('торговый', 'реализованный', 'прибыль', 'остаток')

    for row in ws.iter_rows(min_row=4, max_row=ws.max_row, min_col=1, max_col=13):
        for cell in row:
            cell.border = thin_border
            val = str(cell.value or '').lower()
            if cell.column == 1 and any(k in val for k in summary_kw):
                cell.alignment = left_align
                cell.font      = bold_font
            else:
                cell.alignment = Alignment(horizontal='center')

    col_widths = {
        'A': 40, 'B': 14, 'C': 24, 'D': 10,
        'E': 14, 'F': 12, 'G': 18, 'H': 18,
        'I': 14, 'J': 12, 'K': 18, 'L': 18, 'M': 20
    }
    for k, v in col_widths.items():
        ws.column_dimensions[k].width = v

    filename = f"report_{user_id}.xlsx"
    response = HttpResponse(
        content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
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





def _calc_month_profit_filtered(user, month_start, month_end,
                                 exchange_filter='', bank_filter_id=''):
    """
    Считает прибыль за месяц по логике Excel с учётом фильтров.

    remainder_qty_calc    — для расчётов (max 0, не уходит в минус)
    remainder_qty_display — для отображения (может быть отрицательным)
    """
    # --- Переходящий остаток — всегда без фильтра ---
    prev_orders = Order.objects.filter(
        user=user,
        created_at__gte=SYSTEM_START,
        created_at__lt=month_start
    ).order_by('created_at')

    prev_buy_qty    = 0.0
    prev_buy_cost   = 0.0
    prev_sell_qty   = 0.0
    prev_exch_usdt  = 0.0
    prev_last_price = 0.0

    for o in prev_orders:
        amt = float(o.amount or 0)
        if o.operation_type == 'BUY':
            prev_buy_qty    += amt
            prev_buy_cost   += float(o.cost or 0)
            prev_last_price  = float(o.price or 0)
        else:
            exch_rate = float(o.exchange_commission_rate or 0)
            prev_sell_qty   += amt
            prev_exch_usdt  += amt * exch_rate / 100

    prev_balance_qty  = prev_buy_qty - prev_sell_qty - prev_exch_usdt
    prev_balance_cost = prev_balance_qty * prev_last_price

    # --- Ордера текущего месяца С фильтрами ---
    month_orders = Order.objects.filter(
        user=user,
        created_at__gte=month_start,
        created_at__lt=month_end
    )
    if exchange_filter:
        month_orders = month_orders.filter(exchange_type__icontains=exchange_filter)
    if bank_filter_id:
        month_orders = month_orders.filter(bank_detail_id=bank_filter_id)

    month_orders = month_orders.order_by('created_at')

    month_buy_qty    = 0.0; month_buy_cost   = 0.0
    month_buy_comm   = 0.0
    month_sell_qty   = 0.0; month_sell_cost  = 0.0
    month_sell_comm  = 0.0
    month_exch_usdt  = 0.0
    month_last_price = prev_last_price

    for o in month_orders:
        amt        = float(o.amount or 0)
        cost       = float(o.cost   or 0)
        price      = float(o.price  or 0)
        comm_val   = float(o.commission or 0)
        total_comm = cost * comm_val / 100 if o.commission_type == 'PERCENT' else comm_val

        if o.operation_type == 'BUY':
            month_buy_qty    += amt
            month_buy_cost   += cost
            month_buy_comm   += total_comm
            month_last_price  = price
        else:
            exch_rate = float(o.exchange_commission_rate or 0)
            month_sell_qty   += amt
            month_sell_cost  += cost
            month_sell_comm  += total_comm
            month_exch_usdt  += amt * exch_rate / 100

    total_buy_qty  = prev_balance_qty  + month_buy_qty
    total_buy_cost = prev_balance_cost + month_buy_cost

    # Остаток для отображения — может быть отрицательным
    remainder_qty_display = total_buy_qty - month_sell_qty - month_exch_usdt
    # Остаток для расчётов — не уходит в минус (иначе себестоимость будет завышена)
    remainder_qty_calc    = max(0.0, remainder_qty_display)
    remainder_cost        = remainder_qty_calc * month_last_price

    eq_buy_cost = total_buy_cost - remainder_cost

    if month_sell_qty == 0:
        gross = 0.0
    else:
        gross = month_sell_cost - eq_buy_cost - month_buy_comm - month_sell_comm

    return {
        'prev_balance_qty':      prev_balance_qty,
        'prev_balance_cost':     prev_balance_cost,
        'month_buy_qty':         month_buy_qty,
        'month_buy_cost':        month_buy_cost,
        'month_buy_comm':        month_buy_comm,
        'month_sell_qty':        month_sell_qty,
        'month_sell_cost':       month_sell_cost,
        'month_sell_comm':       month_sell_comm,
        'month_exch_usdt':       month_exch_usdt,
        'total_buy_qty':         total_buy_qty,
        'total_buy_cost':        total_buy_cost,
        'remainder_qty_display': remainder_qty_display,  # для показа (может быть < 0)
        'remainder_qty_calc':    remainder_qty_calc,      # для расчётов (>= 0)
        'remainder_cost':        remainder_cost,
        'eq_buy_cost':           eq_buy_cost,
        'gross':                 gross,
    }


@login_required(login_url='admin_login')
@user_passes_test(lambda u: u.is_superuser, login_url='admin_login')
def admin_profit_view(request):
    """
    Сводная таблица прибыли по всем пользователям за выбранный месяц.
    Фильтры биржи/банка влияют на весь расчёт.
    Переходящий остаток считается без фильтра.
    Границы месяца в МСК — совпадает с Excel Макса.
    """
    now       = timezone.now()
    year_str  = request.GET.get('year',  str(now.year))
    month_str = request.GET.get('month', str(now.month).zfill(2))

    exchange_filter = request.GET.get('exchange', '')
    bank_filter_id  = request.GET.get('bank', '')

    try:
        year  = int(year_str)
        month = int(month_str)
    except ValueError:
        year  = now.year
        month = now.month

    month_str = str(month).zfill(2)
    share_key = f"{year}-{month_str}"

    # Границы месяца в МСК чтобы совпадать с Excel
    from zoneinfo import ZoneInfo
    MSK = ZoneInfo('Europe/Moscow')
    month_start = datetime(year, month, 1, tzinfo=MSK)
    month_end   = datetime(year + 1, 1, 1, tzinfo=MSK) if month == 12 else datetime(year, month + 1, 1, tzinfo=MSK)

    User  = get_user_model()
    users = User.objects.all().order_by('id')

    user_stats = []

    for u in users:
        calc  = _calc_month_profit_filtered(
            u, month_start, month_end,
            exchange_filter=exchange_filter,
            bank_filter_id=bank_filter_id
        )
        gross = calc['gross']

        month_expenses = float(
            UserExpense.objects.filter(user=u, month=share_key)
            .aggregate(Sum('amount'))['amount__sum'] or 0
        )

        expenses_list = list(
            UserExpense.objects.filter(user=u, month=share_key)
            .values('name', 'amount')
        )

        # НДФЛ считается после вычета расходов (правильная налоговая база)
        taxable    = max(0.0, gross - month_expenses)
        ndfl       = taxable * 0.13 if taxable > 0 else 0
        after_ndfl = taxable - ndfl

        share_percent = 20.0
        if u.profit_shares and isinstance(u.profit_shares, dict):
            share_percent = float(u.profit_shares.get(share_key, 20.0))
        share_amount = after_ndfl * (share_percent / 100) if after_ndfl > 0 else 0

        net_profit = after_ndfl - share_amount

        # Остаток для отображения (может быть отрицательным)
        crypto_balance = calc['remainder_qty_display']

        bank_comm_rub     = calc['month_buy_comm'] + calc['month_sell_comm']
        exchange_comm_rub = calc['month_exch_usdt']

        user_stats.append({
            'user':                  u,
            'crypto_balance':        crypto_balance,        # отображаемый (может < 0)
            'prev_balance_qty':      calc['prev_balance_qty'],
            'prev_balance_cost':     calc['prev_balance_cost'],
            'month_buy_qty':         calc['month_buy_qty'],
            'month_buy_cost':        calc['month_buy_cost'],
            'month_sell_qty':        calc['month_sell_qty'],
            'month_sell_cost':       calc['month_sell_cost'],
            'turnover':              calc['month_sell_cost'] + calc['month_buy_cost'],
            'bank_comm_rub':         bank_comm_rub,
            'exchange_comm_rub':     exchange_comm_rub,
            'total_comm_rub':        bank_comm_rub,
            'eq_buy_cost':           calc['eq_buy_cost'],
            'gross':                 gross,
            'gross_profit_positive': gross >= 0,
            'ndfl':                  ndfl,
            'share_percent':         share_percent,
            'share_amount':          share_amount,
            'month_expenses':        month_expenses,
            'expenses_list':         expenses_list,
            'net_profit':            net_profit,
            'net_profit_positive':   net_profit >= 0,
            'has_activity':          (calc['month_buy_qty'] > 0 or calc['month_sell_qty'] > 0),
        })

    # Итоговые карточки
    summary = {
        'buy_sum':   sum(s['month_buy_cost']  for s in user_stats),
        'sell_sum':  sum(s['month_sell_cost'] for s in user_stats),
        'turnover':  sum(s['month_sell_cost'] + s['month_buy_cost'] for s in user_stats),
        'gross':     sum(s['gross']           for s in user_stats),
        'ndfl':      sum(s['ndfl']            for s in user_stats),
        'our_share': sum(s['share_amount']    for s in user_stats),
        'expenses':  sum(s['month_expenses']  for s in user_stats),
        'net':       sum(s['net_profit']      for s in user_stats),
    }

    months_list = [
        {'num': '01', 'name': 'Янв'},  {'num': '02', 'name': 'Февр'},
        {'num': '03', 'name': 'Март'}, {'num': '04', 'name': 'Апр'},
        {'num': '05', 'name': 'Май'},  {'num': '06', 'name': 'Июнь'},
        {'num': '07', 'name': 'Июль'}, {'num': '08', 'name': 'Авг'},
        {'num': '09', 'name': 'Сент'}, {'num': '10', 'name': 'Окт'},
        {'num': '11', 'name': 'Нояб'}, {'num': '12', 'name': 'Дек'},
    ]

    default_banks = BankDetail.objects.all()

    return render(request, 'custom_admin/profit_list.html', {
        'user_stats':        user_stats,
        'summary':           summary,
        'current_year':      year,
        'current_month':     month_str,
        'months_list':       months_list,
        'selected_exchange': exchange_filter,
        'selected_bank':     bank_filter_id,
        'default_banks':     default_banks,
    })



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
                    original_name = os.path.basename(order.screenshot.name)
                    ext = os.path.splitext(original_name)[1] or '.png'
                    label = order.external_id if order.external_id else f"manual_{order.id}"
                    filename = f"{label}{ext}"

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


