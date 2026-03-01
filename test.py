

import hmac
import hashlib
import base64
import requests
import json
from datetime import datetime, timezone
from urllib.parse import urlencode
import urllib3
urllib3.disable_warnings()

API_KEY = "qz5c4v5b6n-addaf0b0-b00aa4bc-8309e"
API_SECRET = "9db0e581-34931100-b36a09fd-24e71"

HOST = "api.htx.com"
BASE_URL = f"https://{HOST}"

def sign(method, path, params):
    sorted_params = urlencode(sorted(params.items()))
    payload = f"{method}\n{HOST}\n{path}\n{sorted_params}"
    digest = hmac.new(API_SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode()

def make_params(extra={}):
    p = {
        "AccessKeyId": API_KEY,
        "SignatureMethod": "HmacSHA256",
        "SignatureVersion": "2",
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
    }
    p.update(extra)
    return p

endpoints = [
    ("/v2/c2c/order", {}),
    ("/v2/c2c/order/list", {}),
    ("/v2/c2c/orders", {}),
    ("/v2/c2c/offer/list", {}),
    ("/v2/c2c/offer/orders", {}),
    ("/v2/c2c/trade/list", {}),
    ("/v2/c2c/order/history", {}),
    ("/v2/c2c/order", {"offerId": "0"}),
]

for path, extra in endpoints:
    params = make_params(extra)
    params["Signature"] = sign("GET", path, params)
    r = requests.get(f"{BASE_URL}{path}", params=params, verify=False)
    print(f"\n{path} → {r.status_code}")
    try:
        print(json.dumps(r.json(), indent=2, ensure_ascii=False)[:400])
    except:
        print(r.text[:400])