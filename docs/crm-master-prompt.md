# MASTER AI SOFTWARE DEVELOPMENT PROMPT
# JOHNVIVZ CUSTOMER RELATIONSHIP MANAGEMENT SYSTEM

Act as a senior full-stack developer, software architect, CRM specialist, database engineer, and UI/UX designer.

Build a complete Customer Relationship Management System for JOHNVIVZ Grocery Store.

## I. SYSTEM PURPOSE

Develop a cloud-enabled CRM application that manages customers, inquiries, customer service, orders, purchase history, campaigns, promotions, customer feedback, and sales intelligence.

This is one of four independently developed but integrated JOHNVIVZ applications.

CRM has its own database and must communicate with HR, Accounting, and Inventory.

## II. ORGANIZATIONAL HIERARCHY

CRM MANAGER
  └── TEAM LEADER
        └── AGENT

CUSTOMER ACCOUNT is an external customer role.

CRM Manager:
- Manage CRM operations.
- Manage Team Leaders and Agents.
- Monitor customer service.
- Manage campaigns.
- Monitor customer satisfaction.
- Review customer analytics.
- Manage escalations.
- Review sales intelligence.
- Access CRM reports.

Team Leader:
- Manage Agents.
- Assign customer tickets.
- Monitor ticket responses.
- Review escalations.
- Monitor customer concerns.
- Review agent performance.
- Approve assigned operational requests.

Agent:
- Manage customer inquiries.
- Respond to tickets.
- Maintain customer interaction records.
- Assist with customer orders.
- Review purchase history.
- Escalate complaints.
- Update ticket statuses.

Customer Account:
- Register and log in.
- Browse products.
- View product prices.
- View stock availability.
- Submit orders.
- Track purchases.
- Submit complaints.
- Submit inquiries.
- View promotions.
- Submit ratings and feedback.

## III. CUSTOMER MANAGEMENT

Implement:

- Customer registration.
- Customer ID generation.
- Customer profiles.
- Contact information.
- Address management.
- Customer segmentation.
- Customer purchase history.
- Customer preferences.
- Customer interaction history.
- Customer account status.

Customers must only access their own information.

## IV. PRODUCT CATALOG INTEGRATION

Inventory is the official source of product information.

CRM must retrieve:

- Product ID.
- SKU.
- Product name.
- Description.
- Category.
- Product image.
- Selling price.
- Product availability.
- Available stock.

Create a responsive customer catalog.

Do not independently modify product prices or stock balances.

## V. ORDER AND SALES MANAGEMENT

Develop:

- Product catalog.
- Shopping cart.
- Checkout.
- Order creation.
- Order status monitoring.
- Payment recording.
- Sales history.
- Refund requests.
- Cancellation handling.
- Customer notifications.

Order workflow:

1. Customer browses products.
2. CRM retrieves current Inventory information.
3. Customer adds products to cart.
4. Customer submits order.
5. CRM validates availability and price.
6. System requests stock reservation from Inventory, if applicable.
7. Payment is recorded or verified according to the selected payment method.
8. Order becomes confirmed.
9. Fulfillment proceeds.
10. Inventory deducts stock at the agreed fulfillment stage.
11. Completed sales are sent to Accounting.
12. CRM updates purchase history.
13. Customer receives confirmation.

Implement idempotency and prevent duplicate stock deduction.

## VI. CUSTOMER SERVICE MANAGEMENT

Create:

- Inquiry management.
- Support ticket creation.
- Ticket assignment.
- Ticket categories.
- Ticket priority.
- Ticket response.
- Escalation.
- Resolution.
- Customer feedback.

Ticket statuses:

Open
Assigned
In Progress
Waiting for Customer
Escalated
Resolved
Closed

Agent handles normal concerns.

Team Leader handles escalations.

CRM Manager handles higher-level customer service issues.

## VII. DEPARTMENT EMPLOYEE REQUEST APPROVAL

CRM employees use the shared Employee Self-Service portal.

Route employee applications as follows:

Agent → Team Leader → Manager.

Team Leader → Manager.

The CRM application must expose an authorized approval interface or integration endpoint for the shared employee request workflow.

Support:
- Leave / PTO approval.
- Attendance correction approval.
- Overtime application approval.
- Other authorized departmental requests.

After approval, publish the result to HR.

HR remains the official owner of employee leave and employment records.

## VIII. HR INTEGRATION

Receive limited employee references from HR for staff identity, department, position, and account provisioning.

Do not store or expose:
- Employee salary information.
- Bank information.
- Government identification numbers.
- Payroll records.
- Confidential HR documents.

## IX. ACCOUNTING INTEGRATION

Publish completed sales and financial transaction events.

Events:

SaleCompleted
SaleCancelled
RefundIssued
PaymentRecorded

Required transaction data:

- Transaction ID.
- Customer ID.
- Order ID.
- Product IDs.
- Quantities.
- Selling prices.
- Discounts.
- Tax information.
- Payment status.
- Transaction timestamp.
- Total amount.

Accounting owns the financial ledger.

CRM owns customer and order records.

## X. INVENTORY INTEGRATION

Required API endpoints:

GET /api/integration/v1/products
GET /api/integration/v1/products/{id}
GET /api/integration/v1/products/{id}/availability
GET /api/integration/v1/products/{id}/price

Integration events:

ProductCreated
ProductUpdated
ProductPriceUpdated
StockUpdated
StockUnavailable

CRM must receive stock changes and current product prices from Inventory.

## XI. DATABASE ENTITIES

Create normalized tables:

users, roles, permissions, customers, customer_addresses, customer_contacts, customer_segments, customer_preferences, customer_accounts, customer_inquiries, support_tickets, ticket_categories, ticket_assignments, ticket_responses, ticket_escalations, product_references, cart_records, cart_items, customer_orders, customer_order_items, sales_transactions, payment_references, refunds, promotions, promotion_redemptions, loyalty_accounts, loyalty_transactions, campaigns, customer_feedback, customer_ratings, notifications, approval_requests, audit_logs, integration_inbox, integration_outbox, integration_logs.

## XII. DASHBOARDS

CRM MANAGER:
- Total customers
- Active customers
- New customers
- Sales performance
- Customer satisfaction
- Open tickets
- Escalated complaints
- Campaign performance
- Customer retention
- Predictive analytics

TEAM LEADER:
- Total agents
- Assigned tickets
- Unassigned tickets
- Pending responses
- Escalations
- Average response time
- Resolution rate
- Agent performance

AGENT:
- My tickets
- New inquiries
- Pending responses
- Resolved tickets
- Customer profiles
- Recent interactions
- Orders requiring assistance

CUSTOMER ACCOUNT:
- Customer dashboard
- Product catalog
- Shopping cart
- My orders
- Purchase history
- Support tickets
- Promotions
- Feedback
- Notifications

Build four independent dashboards.

## XIII. PREDICTIVE CUSTOMER ANALYTICS

Implement:

- Customer segmentation.
- Repeat purchase analysis.
- Customer retention.
- Purchase trends.
- Customer lifetime value estimates.
- Campaign effectiveness.
- Customer satisfaction trends.
- Frequently purchased products.

Use historical validated data.

Clearly distinguish actual results from predictions.

## XIV. UI/UX

Use JOHNVIVZ corporate styling.

CRM accent color: Purple.

Use a modern responsive SaaS layout with:
- Sidebar.
- KPI cards.
- Customer tables.
- Ticket management interface.
- Customer profile pages.
- Charts.
- Notification center.
- Responsive customer portal.

## XV. SECURITY AND DELIVERABLES

Implement authentication, authorization, validation, API security, rate limiting, audit logs, and customer data privacy.

Generate:
- Complete functional CRM.
- Database migrations.
- ER diagram.
- Architecture diagram.
- Four dashboards.
- Customer portal.
- Order management.
- Ticket management.
- API documentation.
- Analytics.
- Automated tests.
- Integration tests.
- Deployment instructions.

Inspect actual XianFire Framework documentation before development.

Do not build a separate authoritative inventory system.

Do not create fake sales or stock transactions.

Do not declare integration complete until verified with Inventory and Accounting.