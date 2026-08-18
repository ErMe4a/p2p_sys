from django.db import migrations

# Текущий список бирж для ручного ввода (my_orders.html) — сидируем каталог
# этими именами один в один, чтобы ничего не пропало для существующих трейдеров.
EXCHANGE_NAMES = [
    "Bybit", "HTX", "MEXC", "Telegram", "Bitget",
    "Gate", "EMCD", "BingX", "Rapira", "Intelion",
]


def seed_and_grant(apps, schema_editor):
    Exchange = apps.get_model('orders', 'Exchange')
    BankDetail = apps.get_model('orders', 'BankDetail')
    User = apps.get_model('orders', 'User')

    exchanges_by_name = {}
    for name in EXCHANGE_NAMES:
        obj, _ = Exchange.objects.get_or_create(name=name)
        exchanges_by_name[name] = obj

    # Intelion остаётся закрытым по умолчанию — доступ выдаётся из админки
    # индивидуально (см. задачу "доступ к банкам/биржам").
    non_intelion_exchanges = [
        e for name, e in exchanges_by_name.items() if name != "Intelion"
    ]
    all_banks = list(BankDetail.objects.filter(is_deleted=False))

    # ВАЖНО: существующим юзерам открываем ВСЁ текущее (кроме Intelion),
    # чтобы у активных трейдеров ничего не пропало из выпадающих списков
    # в момент деплоя этой фичи. Новые юзеры (создаются после) получают
    # дефолт "только Сбербанк / всё кроме Intelion" отдельно в коде
    # (views.admin_users_list, create_user), эта миграция их не касается.
    for user in User.objects.all():
        user.allowed_banks.set(all_banks)
        user.visible_banks.set(all_banks)
        user.allowed_exchanges.set(non_intelion_exchanges)
        user.visible_exchanges.set(non_intelion_exchanges)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('orders', '0033_exchange_user_allowed_banks_user_visible_banks_and_more'),
    ]

    operations = [
        migrations.RunPython(seed_and_grant, noop),
    ]
