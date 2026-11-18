/*
 * Loyalty points, P8 (decision D13, 2026-11-13). The rules, all in this file:
 *   earn     1 point for every PHP 100 of a COMPLETED sale's net amount (after promotions and loyalty discounts), whole points only
 *   reverse  a recorded refund takes back the points the refunded money had earned: the sale keeps
 *            floor((net - refunded) / 100) points in total ("net of refunds")
 *   redeem   100 points = PHP 10 off a LATER order (multiples of 100, never more than what the order still costs)
 *   return   a cancelled order gives its redeemed points back, once
 *   no expiry; one account per customer (created at the first earn); every earn, redeem, reversal and return is a loyalty_transactions row
 * Points are signed in loyalty_transactions: earn and return are positive, redeem and reverse negative. The balance can never go below
 * zero (CHECK): if a customer already spent points that a refund takes back, only the points still in the account are reversed and the
 * shortfall is written in the reason (open point in the P8 report).
 * Demo orders earn demo points like real ones; seed:clear removes them with the demo customers.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { AppError } from "../helpers/errors.js";

export const PESO_PER_POINT_EARNED = 100; // PHP 100 of net sales = 1 point
export const POINTS_PER_BLOCK = 100; // redeem in blocks of 100 points
export const PESOS_PER_BLOCK = 10; // 100 points = PHP 10
export const RULES_TEXT = "1 point for every ₱100 of a completed purchase. 100 points = ₱10 off a later order. Points never expire. A refund takes back the points the refunded amount earned.";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });
const cents = (n) => Math.round(Number(n) * 100);

export const pointsFor = (netAmount) => Math.max(0, Math.floor(cents(netAmount) / (PESO_PER_POINT_EARNED * 100)));
export const pesosFor = (points) => (points / POINTS_PER_BLOCK) * PESOS_PER_BLOCK;

const accountOf = async (customerId, transaction, { lock = false, create = false } = {}) => {
  let [acct] = await select(`SELECT * FROM loyalty_accounts WHERE customer_id = :customerId ${lock ? "FOR UPDATE" : ""}`, { customerId }, transaction);
  if (!acct && create) {
    await exec("INSERT IGNORE INTO loyalty_accounts (customer_id, points_balance, status) VALUES (?, 0, 'active')", [customerId], transaction);
    [acct] = await select(`SELECT * FROM loyalty_accounts WHERE customer_id = :customerId ${lock ? "FOR UPDATE" : ""}`, { customerId }, transaction);
  }
  return acct || null;
};

const addTxn = async ({ account, type, points, saleId = null, refundId = null, reason, userId = null, at = null, transaction }) => {
  const [id] = await sequelize.query(
    "INSERT INTO loyalty_transactions (loyalty_account_id, sales_transaction_id, refund_id, txn_type, points, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    { replacements: [account.id, saleId, refundId, type, points, String(reason).slice(0, 255), userId, at || new Date()], transaction });
  await exec("UPDATE loyalty_accounts SET points_balance = points_balance + ? WHERE id = ?", [points, account.id], transaction);
  return id;
};

export const balanceOf = async (customerId, transaction) => {
  const acct = await accountOf(customerId, transaction);
  return acct ? Number(acct.points_balance) : 0;
};

// ---------------------------------------------------------------- earn (inside the completeOrder transaction)
export const earnForSale = async ({ customerId, saleRowId, transactionNo, netAmount, userId = null, at = null, transaction }) => {
  const points = pointsFor(netAmount);
  if (points <= 0) return 0;
  const account = await accountOf(customerId, transaction, { lock: true, create: true });
  const [already] = await select("SELECT id FROM loyalty_transactions WHERE loyalty_account_id = :a AND sales_transaction_id = :s AND txn_type = 'earn'", { a: account.id, s: saleRowId }, transaction);
  if (already) return 0; // the unique key would refuse it anyway: one earn per sale
  await addTxn({ account, type: "earn", points, saleId: saleRowId, reason: `Earned on sale ${transactionNo} (₱${Number(netAmount).toFixed(2)})`, userId, at, transaction });
  return points;
};

// ---------------------------------------------------------------- reverse (inside the recordRefund transaction)
export const reverseForRefund = async ({ customerId, saleRowId, transactionNo, netAmount, refundedTotal, refundId, refundNo, userId = null, at = null, transaction }) => {
  const account = await accountOf(customerId, transaction, { lock: true });
  if (!account) return { reversed: 0, shortfall: 0 };
  const [{ earned }] = await select("SELECT COALESCE(SUM(points), 0) AS earned FROM loyalty_transactions WHERE loyalty_account_id = :a AND sales_transaction_id = :s AND txn_type = 'earn'", { a: account.id, s: saleRowId }, transaction);
  const [{ taken }] = await select(
    `SELECT COALESCE(-SUM(t.points), 0) AS taken FROM loyalty_transactions t JOIN refunds r ON r.id = t.refund_id
     WHERE t.loyalty_account_id = :a AND t.txn_type = 'reverse' AND r.sales_transaction_id = :s`, { a: account.id, s: saleRowId }, transaction);
  const [done] = await select("SELECT id FROM loyalty_transactions WHERE refund_id = :r AND txn_type = 'reverse'", { r: refundId }, transaction);
  if (done) return { reversed: 0, shortfall: 0 }; // this refund was already handled
  const keep = pointsFor(Math.max(0, Number(netAmount) - Number(refundedTotal)));
  const due = Number(earned) - keep - Number(taken);
  if (due <= 0) return { reversed: 0, shortfall: 0 };
  const reversed = Math.min(due, Number(account.points_balance));
  const shortfall = due - reversed;
  if (reversed > 0 || shortfall > 0) {
    await addTxn({
      account, type: "reverse", points: -reversed, refundId, userId, at, transaction,
      reason: `Refund ${refundNo} on sale ${transactionNo}: ${due} point(s) taken back${shortfall ? `; ${shortfall} could not be taken back because they were already spent` : ""}`,
    });
  }
  return { reversed, shortfall };
};

// ---------------------------------------------------------------- redeem and return (inside the placeOrder / cancelOrder transactions)

// Checks a requested redemption: whole blocks of 100, within the balance, and not more than the order still costs. Returns the PHP cents off.
export const checkRedemption = async ({ customerId, points, payableCents, transaction }) => {
  const p = Number(points || 0);
  if (!p) return 0;
  if (!Number.isInteger(p) || p < 0 || p % POINTS_PER_BLOCK !== 0) throw new AppError(`Loyalty points are used in blocks of ${POINTS_PER_BLOCK} (100 points = ₱${PESOS_PER_BLOCK}).`, 422);
  const balance = await balanceOf(customerId, transaction);
  if (p > balance) throw new AppError(`Only ${balance} loyalty point(s) are available.`, 422);
  const off = cents(pesosFor(p));
  if (off > payableCents) throw new AppError("That is more points than the order costs. Use fewer points.", 422);
  return off;
};

export const redeemOnOrder = async ({ customerId, orderRowId, orderNo, points, userId, at = null, transaction }) => {
  const account = await accountOf(customerId, transaction, { lock: true });
  if (!account || Number(account.points_balance) < points) throw new AppError("Not enough loyalty points any more.", 409);
  const amount = pesosFor(points);
  const txnId = await addTxn({ account, type: "redeem", points: -points, userId, at, transaction, reason: `Redeemed on order ${orderNo}: ${points} points = ₱${amount.toFixed(2)} off` });
  await exec("INSERT INTO loyalty_redemptions (loyalty_account_id, sales_order_id, redeem_transaction_id, points, amount, status, created_at) VALUES (?, ?, ?, ?, ?, 'applied', ?)",
    [account.id, orderRowId, txnId, points, amount, at || new Date()], transaction);
  return amount;
};

export const returnRedemption = async ({ orderRowId, orderNo, userId, at = null, transaction }) => {
  const [r] = await select("SELECT * FROM loyalty_redemptions WHERE sales_order_id = :id AND status = 'applied' FOR UPDATE", { id: orderRowId }, transaction);
  if (!r) return 0;
  const [account] = await select("SELECT * FROM loyalty_accounts WHERE id = :id FOR UPDATE", { id: r.loyalty_account_id }, transaction);
  const txnId = await addTxn({ account, type: "adjust", points: r.points, userId, at, transaction, reason: `Order ${orderNo} was cancelled: the ${r.points} redeemed points went back` });
  await exec("UPDATE loyalty_redemptions SET status = 'returned', return_transaction_id = ? WHERE id = ?", [txnId, r.id], transaction);
  return r.points;
};

export const redemptionOf = async (orderRowId, transaction) => {
  const [r] = await select("SELECT points, amount, status FROM loyalty_redemptions WHERE sales_order_id = :id", { id: orderRowId }, transaction);
  return r ? { ...r, amount: Number(r.amount) } : null;
};

// ---------------------------------------------------------------- reading

export const TXN_LABELS = { earn: "Earned", redeem: "Redeemed", reverse: "Taken back (refund)", adjust: "Returned (order cancelled)", expire: "Expired" };

export const customerLoyalty = async (customerId, { limit = 50 } = {}) => {
  const account = await accountOf(customerId);
  if (!account) return { balance: 0, worth: 0, transactions: [], hasAccount: false, options: [], toNext: POINTS_PER_BLOCK };
  const transactions = await select(
    `SELECT t.id, t.txn_type, t.points, t.reason, t.created_at FROM loyalty_transactions t WHERE t.loyalty_account_id = :a ORDER BY t.created_at DESC, t.id DESC LIMIT ${Number(limit) | 0}`, { a: account.id });
  const balance = Number(account.points_balance);
  return { toNext: balance < POINTS_PER_BLOCK ? POINTS_PER_BLOCK - balance : 0, options: redeemOptions(balance), balance, worth: pesosFor(Math.floor(balance / POINTS_PER_BLOCK) * POINTS_PER_BLOCK), hasAccount: true, transactions: transactions.map((t) => ({ ...t, label: TXN_LABELS[t.txn_type] || t.txn_type })) };
};

// The Manager's Loyalty page: every account with its totals. Demo customers are labelled.
export const listAccounts = async ({ q = "", limit = 20, offset = 0 } = {}) => {
  const where = ["1=1"];
  const params = {};
  if (q) { where.push("(c.customer_no LIKE :q OR CONCAT(c.first_name, ' ', c.last_name) LIKE :q)"); params.q = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`; }
  const [{ total }] = await select(`SELECT COUNT(*) AS total FROM loyalty_accounts a JOIN customers c ON c.id = a.customer_id WHERE ${where.join(" AND ")}`, params);
  const rows = await select(
    `SELECT a.id, a.customer_id, a.points_balance, c.customer_no, CONCAT(c.first_name, ' ', c.last_name) AS customer_name, c.is_demo,
            COALESCE(SUM(CASE WHEN t.txn_type = 'earn' THEN t.points END), 0) AS earned,
            COALESCE(-SUM(CASE WHEN t.txn_type = 'redeem' THEN t.points END), 0) AS redeemed,
            COALESCE(-SUM(CASE WHEN t.txn_type = 'reverse' THEN t.points END), 0) AS reversed,
            COALESCE(SUM(CASE WHEN t.txn_type = 'adjust' THEN t.points END), 0) AS returned_points,
            MAX(t.created_at) AS last_activity
     FROM loyalty_accounts a JOIN customers c ON c.id = a.customer_id LEFT JOIN loyalty_transactions t ON t.loyalty_account_id = a.id
     WHERE ${where.join(" AND ")} GROUP BY a.id ORDER BY a.points_balance DESC, a.id LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
  const [sum] = await select(
    `SELECT COUNT(DISTINCT a.id) AS accounts, COALESCE(SUM(a.points_balance), 0) AS outstanding,
            (SELECT COALESCE(SUM(points), 0) FROM loyalty_transactions WHERE txn_type = 'earn') AS earned,
            (SELECT COALESCE(-SUM(points), 0) FROM loyalty_transactions WHERE txn_type = 'redeem') AS redeemed
     FROM loyalty_accounts a`);
  return {
    total: Number(total), rows: rows.map((r) => ({ ...r, points_balance: Number(r.points_balance), earned: Number(r.earned), redeemed: Number(r.redeemed), reversed: Number(r.reversed), returned_points: Number(r.returned_points) })),
    summary: { accounts: Number(sum.accounts), outstanding: Number(sum.outstanding), worth: pesosFor(Math.floor(Number(sum.outstanding) / 100) * 100), earned: Number(sum.earned), redeemed: Number(sum.redeemed) },
  };
};

// The choices offered at checkout: whole blocks of 100 points, up to the balance (at most 20 choices).
export const redeemOptions = (balance) => Array.from({ length: Math.min(20, Math.floor(balance / POINTS_PER_BLOCK)) }, (_, i) => { const pts = (i + 1) * POINTS_PER_BLOCK; return { value: pts, label: `${pts} points (−₱${pesosFor(pts).toFixed(2)})` }; });
