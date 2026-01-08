from django.contrib import admin

from django.contrib import admin
from .models import User, BankDetail, Order, OrderScreenshot

admin.site.register(User)
admin.site.register(BankDetail)
admin.site.register(Order)
admin.site.register(OrderScreenshot)