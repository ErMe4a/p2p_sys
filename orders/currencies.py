# Единое место для названий валют, которые видит пользователь.
#
# Внутри системы монета по-прежнему хранится как "TON" (в Order.currency, в
# ключах расчётов ton_*, в кэше) — биржи по API отдают именно этот тикер. Для
# пользователя (интерфейс, отчёты, чеки) она называется GRAM. Если биржи
# когда-нибудь начнут отдавать тикер GRAM, он приводится обратно к "TON"
# (см. normalize_currency), так что ничего не ломается ни в ту, ни в другую
# сторону.

# Все монеты, которые принимает система (внутренние коды). Единый источник для
# белых списков: тикер от биржи/расширения, ручные формы, Excel, коррекция остатка.
SUPPORTED_CURRENCIES = ("USDT", "TON", "BTC", "ETH", "USDC")

CURRENCY_LABELS = {"TON": "GRAM"}
CURRENCY_ALIASES = {"GRAM": "TON"}


def normalize_currency(raw) -> str:
    """Внутренний код валюты: 'gram' / 'GRAM' -> 'TON', 'usdt' -> 'USDT'."""
    code = str(raw or "").strip().upper()
    return CURRENCY_ALIASES.get(code, code)


def currency_label(code) -> str:
    """Название валюты для пользователя: 'TON' -> 'GRAM', остальные как есть."""
    normalized = normalize_currency(code)
    return CURRENCY_LABELS.get(normalized, normalized)
