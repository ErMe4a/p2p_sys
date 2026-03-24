"""
Запуск:
    python check_mexc_unprocessed.py

Положи этот файл в корень проекта (рядом с manage.py) и запусти.
НИЧЕГО НЕ УДАЛЯЕТ.

Если settings называется иначе — поправь строку DJANGO_SETTINGS_MODULE ниже.
"""

import os
import sys
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
django.setup()

# ─────────────────────────────────────────────────────────────────────────────

import hmac
import hashlib
import time
import requests
import urllib3
from orders.models import UnprocessedOrder

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://api.mexc.com"


def get_mexc_order_status(user, order_id: str) -> str:
    timestamp = int(time.time() * 1000)

    params = {
        "advOrderNo": order_id,
        "timestamp": timestamp,
    }

    query_string = "&".join(f"{k}={v}" for k, v in params.items())
    signature = hmac.new(
        user.mexc_api_secret.encode("utf-8"),
        query_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    url = f"{BASE_URL}/api/v3/fiat/market/order/detail?{query_string}&signature={signature}"

    headers = {
        "X-MEXC-APIKEY": user.mexc_api_key,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    }

    try:
        resp = requests.get(url, headers=headers, timeout=15, verify=False)
        data = resp.json()

        if data.get("code") != 0:
            return f"API_ERROR: code={data.get('code')} msg={data.get('msg')}"

        order_data = data.get("data") or {}
        status = (
            order_data.get("orderDealState")
            or order_data.get("dealState")
            or order_data.get("state")
            or order_data.get("status")
            or "UNKNOWN"
        )

        return f"{status}  |  raw={order_data}"

    except Exception as e:
        return f"REQUEST_ERROR: {e}"


def main():
    qs = (
        UnprocessedOrder.objects
        .filter(exchange_type="MEXC")
        .select_related("user")
        .order_by("user__username", "-created_at")
    )

    total = qs.count()

    if total == 0:
        print("Нет UnprocessedOrder с exchange_type=MEXC")
        return

    print(f"\nНайдено {total} записей MEXC. Проверяем статусы...\n")
    print("-" * 100)

    current_user = None

    for order in qs:
        if order.user != current_user:
            current_user = order.user
            has_keys = bool(
                getattr(current_user, "mexc_api_key", None)
                and getattr(current_user, "mexc_api_secret", None)
            )
            print(
                f"\n👤 Пользователь: {current_user.username}"
                f"  [{'ключи есть' if has_keys else 'КЛЮЧЕЙ НЕТ — пропускаем'}]"
            )

        if not (
            getattr(order.user, "mexc_api_key", None)
            and getattr(order.user, "mexc_api_secret", None)
        ):
            print(f"  {order.order_id}  →  SKIP (нет ключей)")
            continue

        status_str = get_mexc_order_status(order.user, order.order_id)
        print(f"  {order.order_id}  ({order.created_at.strftime('%d.%m.%Y')})  →  {status_str}")

        time.sleep(0.3)

    print("\n" + "-" * 100)
    print("\nГотово. Ничего не удалено.")
    print("Скинь вывод — и сделаем скрипт удаления точно по нужному статусу.\n")


if __name__ == "__main__":
    main()