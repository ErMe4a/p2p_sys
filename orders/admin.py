from django.contrib import admin

from django.contrib import admin
from .models import User, BankDetail, Exchange, Order, OrderScreenshot

admin.site.register(User)
admin.site.register(BankDetail)
admin.site.register(Exchange)
admin.site.register(Order)
admin.site.register(OrderScreenshot)