import crypto from 'crypto';

// ---------- In-memory cache for used txns (reset on cold start) ----------
// 🔴 For production, replace with Vercel KV, Redis, or a DB.
const usedTxns = new Map();

function isTransactionUsed(txn, ttlSeconds = 86400) { // 24h default
  const entry = usedTxns.get(txn);
  if (entry && Date.now() - entry.timestamp < ttlSeconds * 1000) {
    return true;
  }
  usedTxns.set(txn, { timestamp: Date.now() });
  return false;
}

function deleteTransaction(txn) {
  usedTxns.delete(txn);
}

// ---------- UPay Signature Generator ----------
function generateSignature(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + `&key=${secret}`;
  return crypto.createHash('md5').update(signStr).digest('hex');
}

// ---------- Main Handler ----------
export default async function handler(req, res) {
  // Allow GET (URL params) or POST (body)
  const params = req.method === 'POST' ? req.body : req.query;
  const { user, pass, amount, txn } = params;

  // 1. Validate required fields
  if (!user || !pass || !amount || !txn) {
    return res.status(400).json({ 
      error: 'Missing required params: user, pass, amount, txn' 
    });
  }

  // 2. Authenticate YOUR user (email + pass) – replace with your DB
  // Example hardcoded check – store these in environment variables for safety!
  const validUser = process.env.ALLOWED_USER || 'demo@gmail.com';
  const validPass = process.env.ALLOWED_PASS || 'secure123';
  if (user !== validUser || pass !== validPass) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // 3. Validate amount
  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  // 4. Duplicate check (prevent reusing the same txn)
  if (isTransactionUsed(txn)) {
    return res.status(409).json({ error: 'Transaction ID already used' });
  }

  // 5. Prepare UPay order
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
    chainType: '1', // TRC20 – change as needed
    fiatAmount: String(numericAmount),
    fiatCurrency: 'USD',
    notifyUrl: config.notifyUrl,
    // Add other fields required by UPay (e.g., callbackUrl, etc.)
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
    const response = await fetch(
      'https://api.upay.ink/v1/api/open/order/apply',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(orderParams),
      }
    );
    const result = await response.json();

    if (result.code === '0000' && result.data?.payUrl) {
      // Success – keep the txn in the used list
      return res.status(200).json({
        success: true,
        paymentUrl: result.data.payUrl,
        orderId: merchantOrderNo,
      });
    } else {
      // UPay failed – remove the txn so the user can retry
      deleteTransaction(txn);
      return res.status(500).json({ 
        error: result.msg || 'UPay API error' 
      });
    }
  } catch (error) {
    // Error – allow retry
    deleteTransaction(txn);
    console.error('UPay call failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
