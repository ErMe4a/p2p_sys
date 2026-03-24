"""
Запуск прямо на сервере рядом с manage.py:

    # Сначала диагностика (ничего не удаляет):
    python check_mexc_unprocessed.py

    # Когда убедился что всё верно — удаление:
    python check_mexc_unprocessed.py --delete

Логика:
    Тянем с MEXC API список ЗАВЕРШЁННЫХ ордеров (orderDealState=DONE).
    Всё что есть в UnprocessedOrder, но НЕ ПОПАЛО в этот список — отменённые/мусор.
    Именно их и удаляем при --delete.
"""

import os
import sys
import django

# ── Настройка Django ──────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")  # <-- поменяй если надо

try:
    django.setup()
except Exception as e:
    print(f"Ошибка инициализации Django: {e}")
    print("Проверь DJANGO_SETTINGS_MODULE в этом файле (смотри manage.py)")
    sys.exit(1)

import hmac
import hashlib
import time
import requests
import urllib3
from orders.models import UnprocessedOrder

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://api.mexc.com"
DATE_FROM_MS = int(__import__('datetime').datetime(2026, 2, 24).timestamp() * 1000)

DO_DELETE = "--delete" in sys.argv


# ── Получение всех завершённых ордеров с MEXC ─────────────────────────────────

def fetch_all_done_ids(user):
    """
    Тянет все завершённые ордера с MEXC и возвращает set их order_id.
    Если API вернул ошибку — возвращает None (чтобы не удалять лишнего).
    """
    done_ids = set()
    page = 1
    end_time = int(time.time() * 1000)

    while True:
        timestamp = int(time.time() * 1000)

        params = {
            "orderDealState": "DONE",
            "page": page,
            "limit": 50,
            "startTime": DATE_FROM_MS,
            "endTime": end_time,
            "timestamp": timestamp,
        }

        query_string = "&".join(f"{k}={v}" for k, v in params.items())
        signature = hmac.new(
            user.mexc_api_secret.encode("utf-8"),
            query_string.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        url = f"{BASE_URL}/api/v3/fiat/market/order/pagination?{query_string}&signature={signature}"

        headers = {
            "X-MEXC-APIKEY": user.mexc_api_key,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }

        try:
            resp = requests.get(url, headers=headers, timeout=30, verify=False)
            data = resp.json()
        except Exception as e:
            print(f"    [!] Ошибка запроса к MEXC: {e}")
            return None

        if data.get("code") != 0:
            print(f"    [!] MEXC API вернул ошибку: code={data.get('code')} msg={data.get('msg')}")
            return None

        items = data.get("data") or []
        for item in items:
            order_id = str(item.get("advOrderNo") or "").strip()
            if order_id:
                done_ids.add(order_id)

        page_info = data.get("page", {})
        total_pages = page_info.get("totalPage", 1)

        print(f"    Страница {page}/{total_pages}: получено {len(items)} ордеров")

        if page >= total_pages or not items:
            break

        page += 1
        time.sleep(0.3)

    return done_ids


# ── Основная логика ───────────────────────────────────────────────────────────

def main():
    print("=" * 80)
    if DO_DELETE:
        print("  РЕЖИМ: УДАЛЕНИЕ (--delete)")
    else:
        print("  РЕЖИМ: ДИАГНОСТИКА (без удаления)")
        print("  Чтобы удалить: python check_mexc_unprocessed.py --delete")
    print("=" * 80)

    # Группируем UnprocessedOrder по пользователям
    from django.contrib.auth import get_user_model
    User = get_user_model()

    users_with_mexc = (
        UnprocessedOrder.objects
        .filter(exchange_type="MEXC")
        .values_list("user_id", flat=True)
        .distinct()
    )

    if not users_with_mexc:
        print("\nНет UnprocessedOrder с exchange_type=MEXC")
        return

    total_to_delete = []

    for user_id in users_with_mexc:
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            continue

        has_keys = bool(
            getattr(user, "mexc_api_key", None)
            and getattr(user, "mexc_api_secret", None)
        )

        print(f"\nПользователь: {user.username}  [{'ключи есть' if has_keys else 'КЛЮЧЕЙ НЕТ'}]")

        # Берём все его UnprocessedOrder MEXC
        user_orders = list(
            UnprocessedOrder.objects
            .filter(user=user, exchange_type="MEXC")
            .order_by("-created_at")
        )
        print(f"  UnprocessedOrder MEXC в базе: {len(user_orders)}")

        if not has_keys:
            print("  Пропускаем (нет ключей MEXC)")
            continue

        # Тянем завершённые с биржи
        print("  Запрашиваем завершённые ордера с MEXC...")
        done_ids = fetch_all_done_ids(user)

        if done_ids is None:
            print("  [!] Не удалось получить данные с MEXC — пропускаем пользователя")
            continue

        print(f"  Завершённых ордеров на MEXC: {len(done_ids)}")

        # Что есть в базе но нет в DONE — это отменённые/мусор
        to_delete = [o for o in user_orders if o.order_id not in done_ids]
        to_keep   = [o for o in user_orders if o.order_id in done_ids]

        print(f"  Останется (DONE):    {len(to_keep)}")
        print(f"  К удалению (не DONE): {len(to_delete)}")

        if to_delete:
            print("  Ордера к удалению:")
            for o in to_delete:
                print(f"    - {o.order_id}  ({o.created_at.strftime('%d.%m.%Y')})")

        total_to_delete.extend(to_delete)

    # ── Итог ─────────────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print(f"ИТОГО к удалению: {len(total_to_delete)} записей")

    if not total_to_delete:
        print("Нечего удалять.")
        return

    if DO_DELETE:
        ids_to_delete = [o.pk for o in total_to_delete]
        deleted_count, _ = UnprocessedOrder.objects.filter(pk__in=ids_to_delete).delete()
        print(f"УДАЛЕНО: {deleted_count} записей")
    else:
        print("Запусти с --delete чтобы удалить.")

    print("=" * 80 + "\n")


if __name__ == "__main__":
    main()