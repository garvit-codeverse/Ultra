import os
import json
import hashlib
import uuid
import time
import requests
from datetime import datetime
from flask import Flask, request, jsonify

app = Flask(__name__)

# In-memory store for used txns (replace with Redis/Vercel KV)
used_txns = {}

def is_transaction_used(txn, ttl_seconds=86400):
    entry = used_txns.get(txn)
    if entry and (time.time() - entry['timestamp'] < ttl_seconds):
        return True
    used_txns[txn] = {'timestamp': time.time()}
    return False

def delete_transaction(txn):
    used_txns.pop(txn, None)

def generate_signature(params, secret):
    sorted_keys = sorted(params.keys())
    sign_str = '&'.join([f"{k}={params[k]}" for k in sorted_keys]) + f"&key={secret}"
    return hashlib.md5(sign_str.encode()).hexdigest()

@app.route('/api/pay', methods=['GET', 'POST'])
def pay():
    if request.method == 'POST':
        data = request.get_json()
    else:
        data = request.args.to_dict()

    user = data.get('user')
    passwd = data.get('pass')
    amount = data.get('amount')
    txn = data.get('txn')

    if not all([user, passwd, amount, txn]):
        return jsonify({'error': 'Missing user, pass, amount, or txn'}), 400

    # Replace with your own user validation
    VALID_USERS = {'demo@example.com': 'securepass'}
    if VALID_USERS.get(user) != passwd:
        return jsonify({'error': 'Invalid user or password'}), 401

    try:
        numeric_amount = float(amount)
        if numeric_amount <= 0:
            raise ValueError
    except ValueError:
        return jsonify({'error': 'Amount must be a positive number'}), 400

    # Check for duplicate txn
    if is_transaction_used(txn):
        return jsonify({'error': 'Transaction ID already used'}), 409

    # Prepare UPay order
    merchant_order_no = f"ORDER_{txn}"
    config = {
        'appId': os.environ['UPAY_APP_ID'],
        'apiKey': os.environ['UPAY_API_KEY'],
        'secretKey': os.environ['UPAY_SECRET_KEY'],
        'notifyUrl': f"{os.environ['BASE_URL']}/api/webhook/upay"
    }

    params = {
        'appId': config['appId'],
        'merchantOrderNo': merchant_order_no,
        'chainType': '1',  # TRC20
        'fiatAmount': str(numeric_amount),
        'fiatCurrency': 'USD',
        'notifyUrl': config['notifyUrl'],
    }

    sign = generate_signature(params, config['secretKey'])

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
            json=params,
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
            # UPay failed – remove txn from used list to allow retry
            delete_transaction(txn)
            return jsonify({'error': result.get('msg', 'UPay API error')}), 500
    except Exception as e:
        delete_transaction(txn)
        return jsonify({'error': str(e)}), 500

# Vercel expects a handler named `app`
app = app
