from django.db import models
from django.contrib.auth.models import AbstractUser

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


    def __str__(self):
        return self.username

class BankDetail(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='bank_details')
    name = models.CharField(max_length=255, verbose_name="Название счета")
    is_deleted = models.BooleanField(default=False, verbose_name="Удалено")

    def __str__(self):
        return f"{self.name} ({self.user.username})"

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
    
    # Исправленное поле: добавили null=True, blank=True
    bank_detail = models.ForeignKey(
    BankDetail,
    on_delete=models.SET_NULL,
    null=True,
    blank=True,
    verbose_name="Реквизиты/Банк")
    
    
    commission = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    commission_type = models.CharField(max_length=10, choices=COMMISSION_CHOICES, default='PERCENT')
    screenshot = models.ImageField(upload_to='orders/screenshots/', null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    

    def __str__(self):
        return f"{self.operation_type} - {self.external_id}"


class OrderScreenshot(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='screenshots')
    image = models.ImageField(upload_to='screenshots/%Y/%m/%d/', verbose_name="Скриншот")
    uploaded_at = models.DateTimeField(auto_now_add=True)

class UnprocessedOrder(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    order_id = models.CharField(max_length=255, verbose_name="ID ордера на бирже")
    operation_type = models.CharField(max_length=10, verbose_name="Тип") # BUY/SELL
    price = models.DecimalField(max_digits=20, decimal_places=2, verbose_name="Цена")
    amount = models.DecimalField(max_digits=20, decimal_places=8, verbose_name="Кол-во")
    created_at = models.DateTimeField(verbose_name="Дата создания на бирже")
    exchange_type = models.CharField(max_length=20, default='BYBIT')

    def __str__(self):
        return f"Unprocessed {self.order_id}"
    
    