const store = new Map();

export function isTransactionUsed(txn, ttlSeconds = 300) {
  const entry = store.get(txn);
  if (entry && Date.now() - entry.timestamp < ttlSeconds * 1000) {
    return true;
  }
  // Store with a timestamp; we'll keep it until expiry
  store.set(txn, { timestamp: Date.now() });
  return false;
}

// You can also add a function to remove after success if needed,
// but we only mark when we call isTransactionUsed.
// So call isTransactionUsed at the start, and if UPay fails,
// you might want to delete the entry to allow retry.
// Add a delete function:
export function deleteTransaction(txn) {
  store.delete(txn);
}
