# orders/urls.py
from django.urls import path
from . import views

urlpatterns = [
    # Имя 'my_orders' используется в {% url 'my_orders' %}
    path('my-orders/', views.my_orders_list, name='my_orders'),
    
    # Имя 'unprocessed_orders' используется в {% url 'unprocessed_orders' %}
    path('unprocessed/', views.unprocessed_orders_list, name='unprocessed_orders'),
    path('unprocessed/delete/<int:pk>/', views.delete_unprocessed_order, name='delete_unprocessed_order'),
    path('unprocessed/bulk-ignore/', views.bulk_ignore_unprocessed_orders, name='bulk_ignore_unprocessed_orders'),
    # Имя 'settings' используется в {% url 'settings' %}
    path('settings/', views.profile_settings, name='settings'),

    path('edit/<int:order_id>/', views.edit_order, name='edit_order'),
    path('delete/<int:order_id>/', views.delete_order, name='delete_order'),
    path('upload_screen/<int:order_id>/', views.upload_screenshot, name='upload_screenshot'),
    path('upload-screenshot/<int:order_id>/', views.upload_screenshot, name='upload_screenshot'),
    path('upload-screenshot-after/<int:order_id>/', views.upload_screenshot_after, name='upload_screenshot_after'),
    path('fns/', views.my_fns_documents, name='my_fns'),
    path('fns/export/uvedomlenie/', views.user_export_uvedomlenie, name='user_export_uvedomlenie'),
    path('fns/export/nds/', views.user_export_nds, name='user_export_nds'),
    path('fns/toggle/', views.toggle_document_submission, name='toggle_document_submission'),
    path('profit/', views.user_profit_view, name='user_profit'),

    path('p2p-admin/login/', views.admin_login, name='admin_login'),
    path('p2p-admin/logout/', views.admin_logout, name='admin_logout'),

    path('p2p-admin/users/', views.admin_users_list, name='admin_users'),
    path('p2p-admin/catalog/', views.admin_catalog, name='admin_catalog'),
    path('admin-panel/export/excel/', views.export_excel_report, name='export_excel'),
    path('p2p-admin/orders/', views.admin_orders_editor, name='admin_orders_editor'),
    path('p2p-admin/statistics-24h/', views.admin_statistics_24h, name='admin_stats_24h'),
    path('p2p-admin/turnover/', views.admin_turnover_control, name='admin_turnover_control'),
    path('p2p-admin/api/search-users/', views.api_search_users, name='api_search_users'),
    path('p2p-admin/api/get-turnover/<int:user_id>/', views.api_get_turnover, name='api_get_turnover'),
    path('admin-panel/export/screenshots/', views.export_screenshots_view, name='export_screenshots'),\
    path('p2p-admin/profit/', views.admin_profit_view, name='admin_profit'),
    path('p2p-admin/manual-entries/<int:user_id>/', views.admin_manual_entry_list, name='admin_manual_entry_list'),
    path('p2p-admin/manual-entry/save/',            views.admin_manual_entry_save,  name='admin_manual_entry_save'),
    path('p2p-admin/api/user-yearly-profit/', views.api_user_yearly_profit, name='api_user_yearly_profit'),
    path('p2p-admin/manual-entries/upload-excel/', views.admin_manual_entry_upload_excel, name='admin_manual_entry_upload_excel'),
    path('admin-panel/export/uvedomlenie/', views.export_uvedomlenie, name='export_uvedomlenie'),
    path('admin-panel/export/nds/', views.export_nds, name='export_nds'),
    path('admin-panel/fns/', views.admin_fns_documents, name='admin_fns'),
]
