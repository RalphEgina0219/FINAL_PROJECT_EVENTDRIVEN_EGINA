/*
 * Sidebar navigation per role. The four CRM menus follow blueprint supplement E exactly:
 *   Manager:     CRM Overview; Customer Directory; Sales & Orders; Customer Service; Campaigns / Promotions;
 *                Team Performance; Analytics; Escalations; Reports; Settings.
 *   Team Leader: Team Overview; Agent Assignments; Customer Queue; Cases & Complaints; Follow-ups; Orders; Team Reports.
 *   Agent:       My Dashboard; Customers; Interactions; Inquiries; Cases; Orders / Sales; Follow-up Tasks; Notifications.
 *   Customer:    My Profile; My Orders; Order Tracking; Submit Inquiry; Complaint / Feedback; Notifications.
 * Every item opens a live page (the sample screens of the UI pass were replaced phase by phase and removed in P10).
 * The setup System Administrator has its own short menu; it is not one of the four CRM dashboards.
 */

const NAV = {
  crm_manager: [
    { label: "CRM Overview", href: "/crm/manager", icon: "home" },
    { label: "Customer Directory", href: "/crm/customers", icon: "users" },
    { label: "Sales & Orders", href: "/crm/sales", icon: "cart" },
    { label: "Customer Service", href: "/crm/cases", icon: "ticket", badge: "unreadCases" },
    { label: "Campaigns / Promotions", href: "/crm/campaigns", icon: "megaphone", activeOn: ["/crm/campaigns", "/crm/promotions", "/crm/loyalty"] },
    { label: "Team Performance", href: "/crm/team-performance", icon: "headset" },
    { label: "Analytics", href: "/crm/analytics", icon: "chart" },
    { label: "Escalations", href: "/crm/escalations", icon: "arrowUp", badge: "pendingEscalations" },
    { label: "Reports", href: "/crm/reports", icon: "document" },
    { label: "Settings", href: "/crm/settings", icon: "cog", activeOn: ["/crm/settings", "/crm/approvals"] },
  ],
  team_leader: [
    { label: "Team Overview", href: "/crm/team-leader", icon: "home" },
    { label: "Agent Assignments", href: "/crm/team-performance", icon: "headset" },
    { label: "Customer Queue", href: "/crm/queue", icon: "inbox", badge: "queueCount" },
    { label: "Cases & Complaints", href: "/crm/cases", icon: "ticket", badge: "unreadCases" },
    { label: "Follow-ups", href: "/crm/follow-ups", icon: "clock" },
    { label: "Orders", href: "/crm/sales", icon: "cart" },
    { label: "Team Reports", href: "/crm/reports", icon: "document" },
  ],
  agent: [
    { label: "My Dashboard", href: "/crm/agent", icon: "home" },
    { label: "Customers", href: "/crm/customers", icon: "users" },
    { label: "Interactions", href: "/crm/interactions", icon: "chat" },
    { label: "Inquiries", href: "/crm/inquiries", icon: "question" },
    { label: "Cases", href: "/crm/cases", icon: "ticket", badge: "unreadCases" },
    { label: "Orders / Sales", href: "/crm/sales", icon: "cart" },
    { label: "Follow-up Tasks", href: "/crm/follow-ups", icon: "clock" },
    { label: "Notifications", href: "/notifications", icon: "bell", badge: "unreadNotifications" },
  ],
  customer: [
    { label: "My Profile", href: "/portal", icon: "user" },
    { label: "My Orders", href: "/portal/orders", icon: "cart", activeOn: ["/portal/orders", "/portal/shop", "/portal/cart"] },
    { label: "Order Tracking", href: "/portal/tracking", icon: "truck" },
    { label: "Submit Inquiry", href: "/portal/inquiries", icon: "question" },
    { label: "Complaint / Feedback", href: "/portal/cases", icon: "ticket", badge: "unreadCases" },
    { label: "Notifications", href: "/notifications", icon: "bell", badge: "unreadNotifications" },
  ],
  system_admin: [
    { label: "Setup Overview", href: "/setup", icon: "home" },
    { label: "Case Categories", href: "/setup/categories", icon: "tag" },
    { label: "Response Templates", href: "/setup/templates", icon: "document" },
    { label: "CRM Rules & SLA", href: "/setup/settings", icon: "cog" },
    { label: "Staff Accounts (mock HR)", href: "/setup/staff", icon: "key" },
    { label: "Integration Health", href: "/setup/integration", icon: "arrowUp" },
    { label: "Mock ESS Requests", href: "/setup/approvals", icon: "clock" },
    { label: "Mail Log", href: "/setup/mail-log", icon: "inbox" },
    { label: "Audit Log", href: "/setup/audit-logs", icon: "list" },
  ],
};

export const DASHBOARD_PATHS = {
  system_admin: "/setup",
  crm_manager: "/crm/manager",
  team_leader: "/crm/team-leader",
  agent: "/crm/agent",
  customer: "/portal",
};

// Base path of the case pages for each role (customers use the portal).
export const CASES_PATH = { customer: "/portal/cases", crm_manager: "/crm/cases", team_leader: "/crm/cases", agent: "/crm/cases" };

// Marks the item whose href is the longest prefix of the current path as active and fills badges.
export const buildNav = (role, currentPath, counts = {}) => {
  const items = (NAV[role] || []).map((item) => ({ ...item, count: item.badge ? counts[item.badge] || 0 : 0 }));
  let best = null;
  for (const item of items) {
    const bases = [].concat(item.activeOn || (item.href ? [item.href.split("?")[0]] : []));
    for (const base of bases) {
      const match = currentPath === base || currentPath.startsWith(base + "/");
      if (match && (!best || base.length > best.base.length)) best = { item, base };
    }
  }
  if (best) best.item.active = true;
  return items;
};

// Tabs of the sales pages (staff), the campaign pages (Manager) and the customer's shop pages. All live since P5 except Loyalty.
export const SALES_TABS = [["Orders", "/crm/sales"], ["Payments", "/crm/sales/payments"], ["Refunds", "/crm/sales/refunds"], ["New order", "/crm/sales/new"]];
export const CAMPAIGN_TABS = [["Campaigns", "/crm/campaigns"], ["Promotions", "/crm/promotions"], ["Loyalty", "/crm/loyalty"]];
export const PORTAL_TABS = [["My orders", "/portal/orders"], ["Order tracking", "/portal/tracking"], ["Shop", "/portal/shop"], ["Cart", "/portal/cart"]];

// Tabs shared by the "customer area" pages (Interactions, Inquiries, Follow-up tasks); all live since P4.
export const CUSTOMER_AREA_TABS = [["Interactions", "/crm/interactions"], ["Inquiries", "/crm/inquiries"], ["Follow-up tasks", "/crm/follow-ups"]];
