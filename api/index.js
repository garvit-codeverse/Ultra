import crypto from 'crypto';

const usedTxns = new Map();

function isTransactionUsed(txn, ttlSeconds = 86400) {
  const entry = usedTxns.get(txn);
  if (entry && Date.now() - entry.timestamp < ttlSeconds * 1000) return true;
  usedTxns.set(txn, { timestamp: Date.now() });
  return false;
}

function deleteTransaction(txn) {
  usedTxns.delete(txn);
}

function generateSignature(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + `&key=${secret}`;
  return crypto.createHash('md5').update(signStr).digest('hex');
}

export default async function handler(req, res) {
  const params = req.method === 'POST' ? req.body : req.query;
  const { user, pass, amount, txn } = params;

  if (!user || !pass || !amount || !txn) {
    return res.status(400).json({ error: 'Missing user, pass, amount, or txn' });
  }

  // ✅ 'user' can be a number, email, or any string – we just compare it.
  const validUser = process.env.ALLOWED_USER || 'demo';    // e.g., '123456'
  const validPass = process.env.ALLOWED_PASS || 'secure';
  if (user !== validUser || pass !== validPass) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be > 0' });
  }

  if (isTransactionUsed(txn)) {
    return res.status(409).json({ error: 'Transaction ID already used' });
  }

  const merchantOrderNo = `ORDER_${txn}`;
  const config = {
    appId: process.env.UPAY_APP_ID,
    apiKey: process.env.UPAY_API_KEY,
    secretKey: process.env.UPAY_SECRET_KEY,
    notifyUrl: `${process.env.BASE_URL}/api/webhook/upay`,
  };

  const orderParams = {
    appId: config.appId,
    merchantOrderNo,
    chainType: '1',
    fiatAmount: String(numericAmount),
    fiatCurrency: 'USD',
    notifyUrl: config.notifyUrl,
  };

  const sign = generateSignature(orderParams, config.secretKey);
  const headers = {
    'Content-Type': 'application/json',
    'X-UPA-APIKEY': config.apiKey,
    'X-UPA-REQUESTID': crypto.randomUUID(),
    'X-UPA-TIMESTAMP': Date.now().toString(),
    'X-UPA-SIGN': sign,
  };

  try {
    const response = await fetch('https://api.upay.ink/v1/api/open/order/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify(orderParams),
    });
    const result = await response.json();

    if (result.code === '0000' && result.data?.payUrl) {
      return res.status(200).json({
        success: true,
        paymentUrl: result.data.payUrl,
        orderId: merchantOrderNo,
      });
    } else {
      deleteTransaction(txn);
      return res.status(500).json({ error: result.msg || 'UPay error' });
    }
  } catch (error) {
    deleteTransaction(txn);
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
