/*
 * Analytics, P9 (blueprint §10). Every figure comes from real rows. The rules, the same on every analytics page:
 *   - OFFICIAL figures exclude demo data (is_demo = 1), cancelled orders and voided sales; net sales subtract recorded refunds.
 *     "Include demo data" is a switch on each page; when it is on, every page says "includes demo data".
 *   - Days are Asia/Manila days (the database stores Manila local time); money is Philippine pesos.
 *   - The period is chosen on the page (default: the last 30 days, today included).
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { manilaDay } from "./forecastService.js";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const n = (v) => Number(v || 0);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * 86400e3).toISOString().slice(0, 10);

export const periodOf = ({ from, to } = {}) => {
  const end = DAY.test(String(to || "")) ? String(to) : manilaDay();
  const start = DAY.test(String(from || "")) ? String(from) : addDays(end, -29);
  return start <= end ? { from: start, to: end } : { from: end, to: end };
};

const demoSql = (alias, includeDemo) => (includeDemo ? "1=1" : `${alias}.is_demo = 0`);

// ---------------------------------------------------------------- overview
export const overview = async ({ from, to, includeDemo = false }) => {
  const p = { from, to };
  const [sales] = await select(
    `SELECT COUNT(*) AS sales, COALESCE(SUM(s.net_amount), 0) AS gross_net, COALESCE(SUM(s.discount_total), 0) AS discounts,
            COUNT(DISTINCT s.customer_id) AS buyers
     FROM sales_transactions s WHERE s.status <> 'voided' AND DATE(s.completed_at) BETWEEN :from AND :to AND ${demoSql("s", includeDemo)}`, p);
  const [refunds] = await select(
    `SELECT COALESCE(SUM(r.amount), 0) AS refunded, COUNT(*) AS refunds FROM refunds r JOIN sales_transactions s ON s.id = r.sales_transaction_id
     WHERE r.status = 'recorded' AND DATE(r.recorded_at) BETWEEN :from AND :to AND ${demoSql("s", includeDemo)}`, p);
  const [orders] = await select(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.status = 'cancelled'), 0) AS cancelled FROM sales_orders o WHERE DATE(o.created_at) BETWEEN :from AND :to AND ${demoSql("o", includeDemo)}`, p);
  const [cust] = await select(`SELECT COUNT(*) AS new_customers FROM customers c WHERE DATE(c.created_at) BETWEEN :from AND :to AND c.status <> 'merged' AND ${demoSql("c", includeDemo)}`, p);
  const [cases] = await select(
    `SELECT COUNT(*) AS opened, COALESCE(SUM(k.resolved_at IS NOT NULL), 0) AS resolved,
            AVG(CASE WHEN k.first_response_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, k.created_at, k.first_response_at) END) AS avg_first_response,
            COALESCE(SUM(k.first_response_at IS NOT NULL AND k.first_response_at <= k.first_response_due_at), 0) AS fr_on_time, COUNT(k.first_response_at) AS fr_measured
     FROM customer_cases k WHERE DATE(k.created_at) BETWEEN :from AND :to AND ${demoSql("k", includeDemo)}`, p);
  const [csat] = await select(
    `SELECT AVG(r.rating) AS avg, COUNT(*) AS total FROM customer_ratings r JOIN customer_cases k ON k.id = r.case_id WHERE r.subject_type = 'case' AND DATE(r.created_at) BETWEEN :from AND :to AND ${demoSql("k", includeDemo)}`, p);
  const [demo] = await select(
    `SELECT (SELECT COUNT(*) FROM sales_transactions s WHERE s.is_demo = 1 AND DATE(s.completed_at) BETWEEN :from AND :to) + (SELECT COUNT(*) FROM customer_cases k WHERE k.is_demo = 1 AND DATE(k.created_at) BETWEEN :from AND :to) AS demo_rows`, p);
  const net = n(sales.gross_net) - n(refunds.refunded);
  return {
    netSales: Math.round(net * 100) / 100, sales: n(sales.sales), refunded: n(refunds.refunded), refunds: n(refunds.refunds), discounts: n(sales.discounts),
    avgSale: n(sales.sales) ? Math.round((n(sales.gross_net) / n(sales.sales)) * 100) / 100 : 0, buyers: n(sales.buyers),
    orders: n(orders.orders), cancelled: n(orders.cancelled), newCustomers: n(cust.new_customers),
    casesOpened: n(cases.opened), casesResolved: n(cases.resolved), avgFirstResponse: cases.avg_first_response === null ? null : Math.round(n(cases.avg_first_response)),
    firstResponseOnTime: n(cases.fr_measured) ? Math.round((n(cases.fr_on_time) / n(cases.fr_measured)) * 100) : null,
    csat: csat.total ? Math.round(n(csat.avg) * 10) / 10 : null, csatCount: n(csat.total), demoRowsExcluded: includeDemo ? 0 : n(demo.demo_rows),
  };
};

// ---------------------------------------------------------------- sales intelligence
export const salesIntelligence = async ({ from, to, includeDemo = false }) => {
  const p = { from, to };
  const scope = `s.status <> 'voided' AND DATE(s.completed_at) BETWEEN :from AND :to AND ${demoSql("s", includeDemo)}`;
  const byChannel = await select(
    `SELECT o.channel AS label, COUNT(*) AS sales, COALESCE(SUM(s.net_amount), 0) AS value FROM sales_transactions s JOIN sales_orders o ON o.id = s.sales_order_id WHERE ${scope} GROUP BY o.channel ORDER BY value DESC`, p);
  const products = await select(
    `SELECT i.product_name AS label, SUM(i.quantity) AS units, COALESCE(SUM(i.line_total), 0) AS revenue FROM sales_order_items i JOIN sales_transactions s ON s.sales_order_id = i.sales_order_id
     WHERE ${scope} GROUP BY i.product_id, i.product_name ORDER BY revenue DESC LIMIT 10`, p);
  const categories = await select(
    `SELECT COALESCE(pr.category_name, 'Unknown') AS label, COALESCE(SUM(i.line_total), 0) AS revenue FROM sales_order_items i JOIN sales_transactions s ON s.sales_order_id = i.sales_order_id
     LEFT JOIN product_references pr ON pr.product_id = i.product_id WHERE ${scope} GROUP BY label ORDER BY revenue DESC LIMIT 10`, p);
  const promos = await select(
    `SELECT pm.promo_code AS label, COUNT(*) AS uses, COALESCE(SUM(r.discount_amount), 0) AS discount FROM promotion_redemptions r JOIN promotions pm ON pm.id = r.promotion_id
     JOIN sales_orders o ON o.id = r.sales_order_id WHERE o.status <> 'cancelled' AND DATE(r.redeemed_at) BETWEEN :from AND :to AND ${demoSql("o", includeDemo)} GROUP BY pm.id, pm.promo_code ORDER BY uses DESC LIMIT 10`, p);
  const [loyalty] = await select(
    `SELECT COALESCE(SUM(CASE WHEN t.txn_type = 'earn' THEN t.points END), 0) AS earned, COALESCE(-SUM(CASE WHEN t.txn_type = 'redeem' THEN t.points END), 0) AS redeemed
     FROM loyalty_transactions t JOIN loyalty_accounts a ON a.id = t.loyalty_account_id JOIN customers c ON c.id = a.customer_id WHERE DATE(t.created_at) BETWEEN :from AND :to AND ${demoSql("c", includeDemo)}`, p);
  const [pay] = await select(
    `SELECT COALESCE(SUM(pr.method = 'cash'), 0) AS cash, COALESCE(SUM(pr.method = 'cod'), 0) AS cod, COALESCE(SUM(pr.method = 'gcash'), 0) AS gcash, COALESCE(SUM(pr.method = 'maya'), 0) AS maya
     FROM payment_references pr JOIN sales_transactions s ON s.sales_order_id = pr.sales_order_id WHERE pr.status = 'verified' AND ${scope}`, p);
  return {
    byChannel: byChannel.map((r) => ({ label: r.label, sales: n(r.sales), value: n(r.value) })), products: products.map((r) => ({ label: r.label, units: n(r.units), revenue: n(r.revenue) })),
    categories: categories.map((r) => ({ label: r.label, revenue: n(r.revenue) })), promos: promos.map((r) => ({ label: r.label, uses: n(r.uses), discount: n(r.discount) })),
    loyalty: { earned: n(loyalty.earned), redeemed: n(loyalty.redeemed) }, payments: { cash: n(pay.cash), cod: n(pay.cod), gcash: n(pay.gcash), maya: n(pay.maya) },
  };
};

// ---------------------------------------------------------------- customers and retention
export const customersAndRetention = async ({ from, to, includeDemo = false }) => {
  const p = { from, to };
  // customers who bought in the period, split by how many completed purchases they have in total up to the end of the period
  const buyers = await select(
    `SELECT s.customer_id, CONCAT(c.first_name, ' ', c.last_name) AS name, c.customer_no,
            (SELECT COUNT(*) FROM sales_transactions s2 WHERE s2.customer_id = s.customer_id AND s2.status <> 'voided' AND DATE(s2.completed_at) <= :to AND ${demoSql("s2", includeDemo)}) AS lifetime,
            COALESCE(SUM(s.net_amount), 0) AS spent, COUNT(*) AS purchases
     FROM sales_transactions s JOIN customers c ON c.id = s.customer_id WHERE s.status <> 'voided' AND DATE(s.completed_at) BETWEEN :from AND :to AND ${demoSql("s", includeDemo)}
     GROUP BY s.customer_id ORDER BY spent DESC`, p);
  const repeat = buyers.filter((b) => n(b.lifetime) >= 2).length;
  const newCustomers = await select(
    `SELECT DATE_FORMAT(c.created_at, '%Y-%m') AS label, COUNT(*) AS value FROM customers c WHERE c.status <> 'merged' AND DATE(c.created_at) BETWEEN DATE_SUB(:to, INTERVAL 5 MONTH) AND :to AND ${demoSql("c", includeDemo)}
     GROUP BY label ORDER BY label`, p);
  const [channels] = await select(
    `SELECT COALESCE(SUM(c.source = 'portal'), 0) AS portal, COUNT(*) AS total FROM customers c WHERE c.status <> 'merged' AND ${demoSql("c", includeDemo)}`, p);
  const [service] = await select(
    `SELECT COUNT(DISTINCT k.customer_id) AS with_cases, COALESCE(SUM(k.status NOT IN ('resolved','closed')), 0) AS open_cases FROM customer_cases k WHERE DATE(k.created_at) BETWEEN :from AND :to AND ${demoSql("k", includeDemo)}`, p);
  const [loyal] = await select(`SELECT COUNT(*) AS members, COALESCE(SUM(a.points_balance), 0) AS points FROM loyalty_accounts a JOIN customers c ON c.id = a.customer_id WHERE ${demoSql("c", includeDemo)}`);
  const segments = [
    { label: "First purchase", value: buyers.filter((b) => n(b.lifetime) === 1).length },
    { label: "2–3 purchases", value: buyers.filter((b) => n(b.lifetime) >= 2 && n(b.lifetime) <= 3).length },
    { label: "4 or more", value: buyers.filter((b) => n(b.lifetime) >= 4).length },
  ];
  return {
    buyers: buyers.length, repeat, repeatRate: buyers.length ? Math.round((repeat / buyers.length) * 100) : null, segments,
    top: buyers.slice(0, 10).map((b) => ({ name: b.name, customer_no: b.customer_no, spent: n(b.spent), purchases: n(b.purchases), lifetime: n(b.lifetime) })),
    newCustomers: newCustomers.map((r) => ({ label: r.label, value: n(r.value) })), withCases: n(service.with_cases), openCases: n(service.open_cases),
    loyaltyMembers: n(loyal.members), loyaltyPoints: n(loyal.points), portalShare: channels && n(channels.total) ? Math.round((n(channels.portal) / n(channels.total)) * 100) : null,
  };
};

// The Manager dashboard's retention tile: repeat-customer rate over the last 90 days (official: demo excluded unless there is nothing else).
export const retentionTile = async () => {
  const to = manilaDay();
  const from = addDays(to, -89);
  const real = await customersAndRetention({ from, to, includeDemo: false });
  if (real.buyers > 0) return { ...real, includesDemo: false, from, to };
  return { ...(await customersAndRetention({ from, to, includeDemo: true })), includesDemo: true, from, to };
};
