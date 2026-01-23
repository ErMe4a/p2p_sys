# core/urls.py
from django.contrib import admin
from django.urls import path, include
from django.contrib.auth import views as auth_views
from django.views.generic import RedirectView
from django.conf import settings
from django.conf.urls.static import static

from django.http import JsonResponse

def health(request):
    return JsonResponse({"status": "ok"})



urlpatterns = [
    path('admin/', admin.site.urls),
    path("health", health),

    # При заходе на сайт (пустой путь) перекидываем на "Мои ордеры"
    path('', RedirectView.as_view(pattern_name='my_orders', permanent=False)),
    
    # Маршруты для авторизации
    path('login/', auth_views.LoginView.as_view(template_name='registration/login.html'), name='login'),
    path('logout/', auth_views.LogoutView.as_view(next_page='login'), name='logout'),
    
    # Подключаем пути приложения orders
    path('', include('orders.urls')),
    path("api/", include("orders.api_urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)