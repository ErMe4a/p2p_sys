from django.db import models
from django.contrib.auth.models import AbstractUser
from django.utils import timezone

class User(AbstractUser):
    inn = models.CharField(max_length=12, blank=True, null=True, verbose_name="ИНН")
    kkt_id = models.CharField(max_length=255, blank=True, null=True, verbose_name="ID группы ККТ")
    evotor_login = models.CharField(max_length=255, blank=True, null=True, verbose_name="Логин Эвотора")
    evotor_password = models.CharField(max_length=255, blank=True, null=True, verbose_name="Пароль Эвотора")
    payment_address = models.TextField(blank=True, null=True, verbose_name="Место расчетов")
    tax_type = models.CharField(max_length=50, blank=True, null=True, verbose_name="Тип налогообложения")

    htx_access_key = models.CharField(max_length=255, blank=True, null=True, verbose_name="HTX Access Key")
    htx_private_key = models.CharField(max_length=255, blank=True, null=True, verbose_name="HTX Private Key")
    bybit_api_key = models.CharField(max_length=255, blank=True, null=True, verbose_name="Bybit API Key")
    bybit_api_secret = models.CharField(max_length=255, blank=True, null=True, verbose_name="Bybit API Secret")
    mexc_api_key = models.CharField(max_length=255, blank=True, null=True, verbose_name="MEXC Access Key")
    mexc_api_secret = models.CharField(max_length=255, blank=True, null=True, verbose_name="MEXC API Secret")

    bybit_commission = models.DecimalField(max_digits=6, decimal_places=4, default=0.0000, verbose_name="Комиссия Bybit (%)")
    htx_commission = models.DecimalField(max_digits=6, decimal_places=4, default=0.0000, verbose_name="Комиссия HTX (%)")
    mexc_commission = models.DecimalField(max_digits=6, decimal_places=4, default=0.0000, verbose_name="Комиссия MEXC (%)")
    bitget_commission = models.DecimalField(max_digits=6, decimal_places=4, default=0.0000, verbose_name="Комиссия Bitget (%)")
    telegram_commission = models.DecimalField(max_digits=6, decimal_places=4, default=0.0000, verbose_name="Комиссия Telegram (%)")

    initial_crypto_balance = models.DecimalField(max_digits=20, decimal_places=8, default=0, verbose_name="Начальный остаток USDT")
    profit_shares = models.JSONField(default=dict, blank=True, null=True)

    bybit_key_valid = models.BooleanField(default=True, verbose_name="Bybit ключ валиден")
    mexc_key_valid = models.BooleanField(default=True, verbose_name="MEXC ключ валиден")
    # class User(AbstractUser): — рядом с oktmo/kod_no
    middle_name = models.CharField(max_length=150, blank=True, default="", verbose_name="Отчество")
    oktmo  = models.CharField(max_length=11, blank=True, default="", verbose_name="ОКТМО")
    kod_no = models.CharField(max_length=4,  blank=True, default="", verbose_name="Код налогового органа")
    # orders/models.py -> class User
    phone = models.CharField(max_length=15, blank=True, default="", verbose_name="Телефон")

    # Статус ФНС (уведомления/НДС), пересчитывается фоновой задачей
    # tasks.recompute_fns_status_task — как bybit_key_valid/mexc_key_valid,
    # обычное поле, читается в шаблоне напрямую, без AJAX и без кэша.
    FNS_STATUS_CHOICES = [
        ('none', 'Нет активности'),
        ('pending', 'Не всё отправлено'),
        ('ok', 'Всё отправлено'),
    ]
    fns_status_cached = models.CharField(
        max_length=10, choices=FNS_STATUS_CHOICES, default='none', blank=True,
        verbose_name="Статус ФНС (кэш)"
    )

    def __str__(self):
        return self.username



class BankDetail(models.Model):
    name = models.CharField(max_length=255, verbose_name="Название банка")
    is_deleted = models.BooleanField(default=False, verbose_name="Удалено")

    def __str__(self):
        return self.name

class MonthlyManualEntry(models.Model):
    SOURCE_CHOICES = [
        ('manual', 'Вручную'),
        ('excel',  'Excel'),
    ]

    user             = models.ForeignKey(User, on_delete=models.CASCADE, related_name='manual_entries')
    month            = models.CharField(max_length=7)         # '2026-01'
    source           = models.CharField(max_length=10, choices=SOURCE_CHOICES, default='manual')

    # Покупки
    buy_qty          = models.DecimalField(max_digits=20, decimal_places=8, default=0)
    buy_cost         = models.DecimalField(max_digits=20, decimal_places=2, default=0)
    buy_comm         = models.DecimalField(max_digits=20, decimal_places=2, default=0)

    # Продажи
    sell_qty         = models.DecimalField(max_digits=20, decimal_places=8, default=0)
    sell_cost        = models.DecimalField(max_digits=20, decimal_places=2, default=0)
    sell_comm        = models.DecimalField(max_digits=20, decimal_places=2, default=0)

    # Комиссия биржи
    exch_comm_rub    = models.DecimalField(max_digits=20, decimal_places=2, default=0)

    # Остаток
    remainder_qty    = models.DecimalField(max_digits=20, decimal_places=8, default=0)
    remainder_price  = models.DecimalField(max_digits=20, decimal_places=4, default=0)
    remainder_cost   = models.DecimalField(max_digits=20, decimal_places=2, default=0)

    # Прибыль (было раньше)
    gross            = models.DecimalField(max_digits=20, decimal_places=2, default=0)

    created_at = models.DateTimeField(auto_now_add=True, null=True, blank=True)
    updated_at       = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('user', 'month')
        verbose_name = "Ручная запись прибыли"
        verbose_name_plural = "Ручные записи прибыли"

    def __str__(self):
        return f"{self.user.username} — {self.month} [{self.source}]"

class Order(models.Model):
    OPERATION_CHOICES = [('BUY', 'Покупка'), ('SELL', 'Продажа')]
    COMMISSION_CHOICES = [('PERCENT', '%'), ('FIX', '₽')]

    user = models.ForeignKey(User, on_delete=models.CASCADE)
    external_id = models.CharField(max_length=100, verbose_name="Номер ордера", default="")
    price = models.DecimalField(max_digits=20, decimal_places=2, verbose_name="Курс", default=0)
    amount = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="Кол-во", default=0)
    cost = models.DecimalField(max_digits=20, decimal_places=2, verbose_name="Стоимость", default=0)
    operation_type = models.CharField(max_length=4, choices=OPERATION_CHOICES, default='BUY')
    exchange_type = models.CharField(max_length=50, default="Bybit")
    currency = models.CharField(max_length=10, default='USDT', verbose_name="Валюта")
    receipt = models.JSONField(
        verbose_name="Данные чека",
        null=True,
        blank=True,
        default=dict
    )
    bank_detail = models.ForeignKey(
        BankDetail,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        verbose_name="Реквизиты/Банк"
    )
    commission = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    commission_type = models.CharField(max_length=10, choices=COMMISSION_CHOICES, default='PERCENT')
    screenshot = models.ImageField(upload_to='orders/screenshots/', null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    exchange_commission_rate = models.DecimalField(
        max_digits=6,
        decimal_places=4,
        default=0.0000,
        verbose_name="Зафиксированный % биржи"
    )
    # True  = price/cost/amount/type получены из API биржи
    # False = данные ещё не верифицированы, чек ждёт verify_and_receipt_later
    is_verified = models.BooleanField(
        default=False,
        verbose_name="Данные верифицированы через API"
    )
    is_manual = models.BooleanField(
        default=False,
        verbose_name="Данные введены вручную пользователем"
    )

    class Meta:
        indexes = [
            models.Index(fields=['user', 'created_at']),
            models.Index(fields=['user', 'currency', 'created_at']),
        ]

    def __str__(self):
        return f"{self.operation_type} - {self.external_id}"
    
    

class OrderScreenshot(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='screenshots')
    image = models.ImageField(upload_to='screenshots/%Y/%m/%d/', verbose_name="Скриншот")
    uploaded_at = models.DateTimeField(auto_now_add=True)


class UnprocessedOrder(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    order_id = models.CharField(max_length=255, verbose_name="ID ордера на бирже")
    operation_type = models.CharField(max_length=10, verbose_name="Тип")  # BUY/SELL
    price = models.DecimalField(max_digits=20, decimal_places=2, verbose_name="Цена")
    amount = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="Кол-во")
    cost = models.DecimalField(max_digits=20, decimal_places=2, verbose_name="Стоимость", default=0)
    created_at = models.DateTimeField(verbose_name="Дата создания на бирже")
    exchange_type = models.CharField(max_length=20, default='BYBIT')

    class Meta:
        unique_together = ('user', 'order_id')
        verbose_name = "Необработанный ордер"
        verbose_name_plural = "Необработанные ордера"

    def __str__(self):
        return f"Unprocessed {self.order_id}"


class IgnoredOrder(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    order_id = models.CharField(max_length=255, verbose_name="ID ордера на бирже")
    exchange_type = models.CharField(max_length=20, default='BYBIT', verbose_name="Биржа")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Дата игнора")

    class Meta:
        unique_together = ('user', 'order_id')
        verbose_name = "Игнорируемый ордер"
        verbose_name_plural = "Игнорируемые ордера"

    def __str__(self):
        return f"Ignored {self.order_id} ({self.exchange_type})"


class UserExpense(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='expenses')
    name = models.CharField(max_length=255, verbose_name="Наименование")
    amount = models.DecimalField(max_digits=12, decimal_places=2, verbose_name="Сумма (₽)")
    month = models.CharField(max_length=7, verbose_name="Месяц")  # '2026-03'
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-month', 'name']
        verbose_name = "Расход"
        verbose_name_plural = "Расходы"

    def __str__(self):
        return f"{self.name} — {self.amount} ₽ ({self.month})"

class DocumentSubmission(models.Model):
    user = models.ForeignKey(
        User, on_delete=models.CASCADE,
        related_name='document_submissions'
    )
    doc_type = models.CharField(max_length=20)      # 'uvedomlenie' | 'nds'
    period_key = models.CharField(max_length=10)    # 'Q1' | 'H1' | 'M9' | 'Q2' | 'Q3' | 'Q4'
    year = models.IntegerField()
    submitted = models.BooleanField(default=False)
    submitted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = ('user', 'doc_type', 'period_key', 'year')

    def __str__(self):
        return f"{self.user} — {self.doc_type} {self.period_key}/{self.year} — {'✓' if self.submitted else '—'}"
