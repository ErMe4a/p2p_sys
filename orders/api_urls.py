from django.urls import path
from . import api_views

urlpatterns = [
    path("auth/login", api_views.auth_login),
    path("auth/login/", api_views.auth_login),

    path("users/me", api_views.users_me),
    path("users/me/", api_views.users_me),

    path("details", api_views.details),
    path("details/", api_views.details),
    path("details/<int:pk>", api_views.details_delete),
    path("details/<int:pk>/", api_views.details_delete),

    path("order", api_views.order),          # GET(id=...) и POST(save)
    path("order/", api_views.order),

    path("order/my", api_views.order_my),
    path("order/my/", api_views.order_my),

    path("order/by-string-id", api_views.order_by_string_id),
    path("order/by-string-id/", api_views.order_by_string_id),

    path("order/screenshot", api_views.order_screenshot),
    path("order/screenshot/", api_views.order_screenshot),

    path("order/<str:order_id>", api_views.order_delete),
    path("order/<str:order_id>/", api_views.order_delete),
]
