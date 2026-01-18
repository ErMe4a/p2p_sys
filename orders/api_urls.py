from django.urls import path
from . import api_views

urlpatterns = [
    # --- Auth ---
    path("auth/login", api_views.auth_login),

    # --- User ---
    path("users/me", api_views.users_me),

    # --- Bank Details ---
    path("details", api_views.details),
    path("details/<int:pk>", api_views.details_delete),

    # --- Orders (Специальные пути ВЫШЕ универсальных) ---
    path("order/my", api_views.order_my),                     # Список моих ордеров
    path("order/by-string-id", api_views.order_by_string_id), # Поиск по строковому ID (для MEXC)
    path("order/screenshot", api_views.order_screenshot),     # Загрузка/просмотр скриншота

    # --- Orders (Основные) ---
    path("order", api_views.order),                           # GET (поиск по id) / POST (сохранение)
    
    # ВАЖНО: Этот путь ловит всё, что похоже на ID, поэтому он в самом низу секции order
    path("order/<str:order_id>", api_views.order_delete),     # Удаление по ID
]