import os
import json
import hashlib
import uuid
import time
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

# ---------- In-memory cache for used txns ----------
used_txns = {}

def is_transaction_used(txn, ttl_seconds=86400):
    entry = used_txns.get(txn)
    if entry and (time.time() - entry['timestamp'] < ttl_seconds):
        return True
    used_txns[txn] = {'timestamp': time.time()}
    return False

def delete_transaction(txn):
    used_txns.pop(txn, None)

# ---------- UPay Signature ----------
def generate_signature(params, secret):
    sorted_keys = sorted(params.keys())
    sign_str = '&'.join([f"{k}={params[k]}" for k in sorted_keys]) + f"&key={secret}"
    return hashlib.md5(sign_str.encode()).hexdigest()

# ---------- Main Handler ----------
@app.route('/', methods=['GET', 'POST'])
# Or if mapped to /api, keep it. Vercel routes /api to index.py
def handler():
    if request.method == 'POST':
        data = request.get_json() or {}
    else:
        data = request.args.to_dict()

    user = data.get('user')
    passwd = data.get('pass')
    amount = data.get('amount')
    txn = data.get('txn')

    if not all([user, passwd, amount, txn]):
        return jsonify({'error': 'Missing user, pass, amount, or txn'}), 400

    # Replace with your own auth logic
    valid_user = os.getenv('ALLOWED_USER', 'demo@gmail.com')
    valid_pass = os.getenv('ALLOWED_PASS', 'secure123')
    if user != valid_user or passwd != valid_pass:
        return jsonify({'error': 'Invalid email or password'}), 401

    try:
        numeric_amount = float(amount)
        if numeric_amount <= 0:
            raise ValueError
    except ValueError:
        return jsonify({'error': 'Amount must be a positive number'}), 400

    if is_transaction_used(txn):
        return jsonify({'error': 'Transaction ID already used'}), 409

    merchant_order_no = f"ORDER_{txn}"
    config = {
        'appId': os.environ['UPAY_APP_ID'],
        'apiKey': os.environ['UPAY_API_KEY'],
        'secretKey': os.environ['UPAY_SECRET_KEY'],
        'notifyUrl': f"{os.environ['BASE_URL']}/api/webhook/upay"
    }

    order_params = {
        'appId': config['appId'],
        'merchantOrderNo': merchant_order_no,
        'chainType': '1',
        'fiatAmount': str(numeric_amount),
        'fiatCurrency': 'USD',
        'notifyUrl': config['notifyUrl'],
    }

    sign = generate_signature(order_params, config['secretKey'])
    headers = {
        'Content-Type': 'application/json',
        'X-UPA-APIKEY': config['apiKey'],
        'X-UPA-REQUESTID': str(uuid.uuid4()),
        'X-UPA-TIMESTAMP': str(int(time.time() * 1000)),
        'X-UPA-SIGN': sign,
    }

    try:
        resp = requests.post(
            'https://api.upay.ink/v1/api/open/order/apply',
            headers=headers,
            json=order_params,
            timeout=30
        )
        result = resp.json()
        if result.get('code') == '0000' and result.get('data', {}).get('payUrl'):
            return jsonify({
                'success': True,
                'paymentUrl': result['data']['payUrl'],
                'orderId': merchant_order_no
            }), 200
        else:
            delete_transaction(txn)
            return jsonify({'error': result.get('msg', 'UPay error')}), 500
    except Exception as e:
        delete_transaction(txn)
        print(f"UPay error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

# Vercel expects `app` as the WSGI handler
app = app
