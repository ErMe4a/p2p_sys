

import hmac
import hashlib
import time
import requests

API_KEY = "mx0vglq5X5SQjMfWOn"
API_SECRET = "9071e4d0e1ef4f78b85ce1b725246d90"

BASE_URL = "https://api.mexc.com"

def sign(query_string: str, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        query_string.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

def get_orders():
    timestamp = int(time.time() * 1000)
    start_time = timestamp - 30 * 24 * 60 * 60 * 1000

    # Строим строку параметров БЕЗ сортировки, signature и timestamp — в конце
    params = {
        "orderDealState": "DONE",
        "page": 1,
        "limit": 10,
        "startTime": start_time,
        "endTime": timestamp,
        "timestamp": timestamp,
    }

    # Формируем строку вручную в нужном порядке
    query_string = "&".join(f"{k}={v}" for k, v in params.items())
    signature = sign(query_string, API_SECRET)

    url = f"{BASE_URL}/api/v3/fiat/market/order/pagination?{query_string}&signature={signature}"

    headers = {
        "X-MEXC-APIKEY": API_KEY,
        "Content-Type": "application/json",
    }

    response = requests.get(url, headers=headers)
    print("Status:", response.status_code)
    import json
    print("Response:", json.dumps(response.json(), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    get_orders()