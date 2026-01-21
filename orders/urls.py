# orders/urls.py
from django.urls import path
from . import views

urlpatterns = [
    # Имя 'my_orders' используется в {% url 'my_orders' %}
    path('my-orders/', views.my_orders_list, name='my_orders'),
    
    # Имя 'unprocessed_orders' используется в {% url 'unprocessed_orders' %}
    path('unprocessed/', views.unprocessed_orders_list, name='unprocessed_orders'),
    
    # Имя 'settings' используется в {% url 'settings' %}
    path('settings/', views.profile_settings, name='settings'),

    path('edit/<int:order_id>/', views.edit_order, name='edit_order'),
    path('delete/<int:order_id>/', views.delete_order, name='delete_order'),
    path('upload_screen/<int:order_id>/', views.upload_screenshot, name='upload_screenshot'),
    path('upload-screenshot/<int:order_id>/', views.upload_screenshot, name='upload_screenshot'),
    path('p2p-admin/login/', views.admin_login, name='admin_login'),
    path('p2p-admin/logout/', views.admin_logout, name='admin_logout'),

    path('p2p-admin/users/', views.admin_users_list, name='admin_users'),
    path('admin-panel/export/excel/', views.export_excel_report, name='export_excel'),
    path('p2p-admin/orders/', views.admin_orders_editor, name='admin_orders_editor'),
    path('p2p-admin/statistics-24h/', views.admin_statistics_24h, name='admin_stats_24h'),
    path('p2p-admin/turnover/', views.admin_turnover_control, name='admin_turnover_control'),
    path('p2p-admin/api/search-users/', views.api_search_users, name='api_search_users'),
    path('p2p-admin/api/get-turnover/<int:user_id>/', views.api_get_turnover, name='api_get_turnover'),
    
]