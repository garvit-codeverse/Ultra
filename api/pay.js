import { createOrder } from '../utils/upay.js';
import { isTransactionUsed } from '../utils/cache.js';

export default async function handler(req, res) {
  // Allow both GET and POST
  const params = req.method === 'POST' ? req.body : req.query;
  const { user, pass, amount, txn } = params;

  // 1. Validate required fields
  if (!user || !pass || !amount || !txn) {
    return res.status(400).json({ error: 'Missing user, pass, amount, or txn' });
  }

  // 2. Authenticate YOUR app's user (replace with your own logic)
  const VALID_USERS = {
    'demo@example.com': 'securepass', // example – use environment or DB
  };
  if (!VALID_USERS[user] || VALID_USERS[user] !== pass) {
    return res.status(401).json({ error: 'Invalid user or password' });
  }

  // 3. Validate amount
  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  // 4. Check if this txn has already been used
  //    (You can store used txns in a cache, DB, or Vercel KV)
  if (isTransactionUsed(txn, 86400)) { // 24h expiry
    return res.status(409).json({ error: 'Transaction ID already used' });
  }

  // 5. Generate a merchant order ID (or reuse txn)
  const merchantOrderNo = `ORDER_${txn}`; // or unique

  // 6. Call UPay API
  const config = {
    appId: process.env.UPAY_APP_ID,
    apiKey: process.env.UPAY_API_KEY,
    secretKey: process.env.UPAY_SECRET_KEY,
    platformPublicKey: process.env.UPAY_PLATFORM_PUBLIC_KEY, // optional
    notifyUrl: `${process.env.BASE_URL}/api/webhook/upay`,
  };

  try {
    const result = await createOrder(numericAmount, merchantOrderNo, config);
    if (result.code === '0000' && result.data?.payUrl) {
      // Mark txn as used (successfully created order)
      // (already marked in isTransactionUsed check, but we need to store it)
      // Actually the isTransactionUsed function should store the txn after check.
      // We'll handle that inside the function – see cache.js below.
      return res.status(200).json({
        success: true,
        paymentUrl: result.data.payUrl,
        orderId: merchantOrderNo,
      });
    } else {
      // If UPay fails, we should NOT mark txn as used – allow retry.
      return res.status(500).json({ error: result.msg || 'UPay API error' });
    }
  } catch (error) {
    console.error('UPay error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
