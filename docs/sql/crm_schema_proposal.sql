-- SUPERSEDED (2026-11-12): the schema actually built is migrations/101-112 (see docs/sql/johnvivz_crm_db_schema.sql).
-- Kept for the P0 review record only.
-- =====================================================================================
-- JOHNVIVZ CRM — proposed physical schema for johnvivz_crm_db           (REVIEW ONLY)
-- Status: PROPOSAL. Not executed. After approval it becomes migrations/1xx_*.js files
--         run with `npm run migrate` (DB_NAME=johnvivz_crm_db).
-- Source of names: blueprint §7, §12, supplement E (CRM data entities).
-- Tables marked [CRM-LOCAL] are not in the blueprint list; each has a reason.
-- Conventions: INT surrogate PK for joins inside CRM; CHAR(36) UUID for IDs shared with
--              other applications (customer_id, order_id, sale_id, refund_id, event_id).
--              Times are stored in Asia/Manila (+08:00); money is DECIMAL(12,2) PHP.
-- =====================================================================================
CREATE DATABASE IF NOT EXISTS johnvivz_crm_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE johnvivz_crm_db;

-- -------------------------------------------------------------------------------------
-- 0. Infrastructure
-- -------------------------------------------------------------------------------------
CREATE TABLE migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  batch INT NOT NULL,
  run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- [CRM-LOCAL] Daily counters for human-readable numbers (CASE / INQ / SO / SALE / RFD).
CREATE TABLE number_sequences (
  scope VARCHAR(20) NOT NULL,           -- 'case','inquiry','order','sale','refund'
  seq_date DATE NOT NULL,
  last_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, seq_date)
);

-- [CRM-LOCAL] CRM configuration (reopen window, auto-close days, adapter modes shown read-only).
CREATE TABLE crm_settings (
  setting_key VARCHAR(60) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  description VARCHAR(255) NULL,
  updated_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------------------
-- 1. Synchronized references (read-only snapshots; NEVER the source of truth)
-- -------------------------------------------------------------------------------------
CREATE TABLE department_references (          -- [CRM-LOCAL] HR department snapshot
  id INT AUTO_INCREMENT PRIMARY KEY,
  department_id VARCHAR(64) NOT NULL UNIQUE,    -- HR stable ID
  code VARCHAR(30) NULL,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_hr',
  source_version VARCHAR(40) NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  last_synced_at DATETIME NOT NULL
);

CREATE TABLE position_references (            -- [CRM-LOCAL] HR position snapshot
  id INT AUTO_INCREMENT PRIMARY KEY,
  position_id VARCHAR(64) NOT NULL UNIQUE,
  department_id VARCHAR(64) NULL,
  title VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_hr',
  source_version VARCHAR(40) NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  last_synced_at DATETIME NOT NULL
);

CREATE TABLE employee_references (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(64) NOT NULL UNIQUE,      -- HR stable ID
  full_name VARCHAR(150) NOT NULL,
  work_email VARCHAR(254) NULL,
  department_id VARCHAR(64) NULL,
  position_id VARCHAR(64) NULL,
  employment_status ENUM('active','on_leave','inactive','separated') NOT NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_hr',
  source_version VARCHAR(40) NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,        -- mock-mode record, clearly labelled
  last_synced_at DATETIME NOT NULL,
  INDEX employee_references_status_idx (employment_status)
);

CREATE TABLE product_references (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL UNIQUE,       -- Inventory stable ID
  sku VARCHAR(64) NOT NULL UNIQUE,
  barcode VARCHAR(64) NULL,
  name VARCHAR(200) NOT NULL,
  category_name VARCHAR(120) NULL,
  unit VARCHAR(30) NULL,
  selling_price DECIMAL(12,2) NOT NULL,         -- owned by Inventory; CRM never edits it
  is_vatable TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  available_qty DECIMAL(12,3) NULL,             -- last availability answer from Inventory
  availability_checked_at DATETIME NULL,
  low_stock TINYINT(1) NOT NULL DEFAULT 0,      -- from LowStockDetected
  source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_inventory',
  source_version VARCHAR(40) NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  last_synced_at DATETIME NOT NULL,
  INDEX product_references_name_idx (name)
);

-- -------------------------------------------------------------------------------------
-- 2. Customer master (CRM is the owner)
-- -------------------------------------------------------------------------------------
CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id CHAR(36) NOT NULL UNIQUE,         -- shared UUID used by Inventory/Accounting
  customer_no VARCHAR(20) NOT NULL UNIQUE,      -- CUS-000001
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NULL,
  mobile VARCHAR(30) NULL,
  normalized_email VARCHAR(254) NULL,           -- lower(trim(email)) for duplicate checks
  normalized_mobile VARCHAR(20) NULL,           -- digits only, 09XXXXXXXXX form
  customer_type ENUM('individual','business') NOT NULL DEFAULT 'individual',
  source ENUM('walk_in','portal','phone','social','referral','migration','other') NOT NULL DEFAULT 'walk_in',
  status ENUM('active','inactive','merged') NOT NULL DEFAULT 'active',
  merged_into_id INT NULL,
  notes TEXT NULL,
  created_by INT NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX customers_email_idx (normalized_email),
  INDEX customers_mobile_idx (normalized_mobile),
  INDEX customers_name_idx (last_name, first_name),
  CONSTRAINT customers_merged_fk FOREIGN KEY (merged_into_id) REFERENCES customers(id)
);

CREATE TABLE customer_contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  contact_type ENUM('mobile','landline','email','messenger','other') NOT NULL,
  value VARCHAR(254) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT customer_contacts_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE customer_addresses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  label VARCHAR(40) NULL,                       -- Home, Work
  line1 VARCHAR(200) NOT NULL,
  barangay VARCHAR(100) NULL,
  city_municipality VARCHAR(100) NULL,
  province VARCHAR(100) NULL,
  postal_code VARCHAR(10) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT customer_addresses_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE customer_preferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  preference_key VARCHAR(60) NOT NULL,          -- preferred_channel, preferred_branch, language
  preference_value VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY customer_preferences_unique (customer_id, preference_key),
  CONSTRAINT customer_preferences_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE customer_consents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  consent_type ENUM('data_privacy','terms','marketing_sms','marketing_email') NOT NULL,
  granted TINYINT(1) NOT NULL,
  policy_version VARCHAR(20) NOT NULL,
  channel ENUM('portal','in_store','phone','paper') NOT NULL,
  recorded_by INT NULL,
  granted_at DATETIME NULL,
  withdrawn_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX customer_consents_idx (customer_id, consent_type),
  CONSTRAINT customer_consents_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- -------------------------------------------------------------------------------------
-- 3. CRM users and teams (identity from HR; CRM keeps only access data)
-- -------------------------------------------------------------------------------------
CREATE TABLE crm_teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  team_leader_id INT NULL,
  manager_id INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE crm_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_type ENUM('staff','customer') NOT NULL,
  role ENUM('crm_manager','team_leader','agent','customer') NOT NULL,
  employee_id VARCHAR(64) NULL UNIQUE,          -- staff: HR employee_id
  customer_ref_id INT NULL UNIQUE,              -- customer portal account -> customers.id
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  team_id INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,      -- CRM access switch
  is_available TINYINT(1) NOT NULL DEFAULT 1,   -- agents: accepts new assignments
  email_verified_at DATETIME NULL,
  last_login_at DATETIME NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT crm_users_type_chk CHECK (
    (user_type = 'staff' AND role <> 'customer' AND customer_ref_id IS NULL) OR
    (user_type = 'customer' AND role = 'customer' AND employee_id IS NULL AND customer_ref_id IS NOT NULL)),
  -- No referential action here: MySQL forbids CHECK constraints on columns with ON UPDATE/DELETE actions.
  CONSTRAINT crm_users_employee_fk FOREIGN KEY (employee_id) REFERENCES employee_references(employee_id),
  CONSTRAINT crm_users_customer_fk FOREIGN KEY (customer_ref_id) REFERENCES customers(id),
  CONSTRAINT crm_users_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE SET NULL
);

ALTER TABLE crm_teams
  ADD CONSTRAINT crm_teams_leader_fk FOREIGN KEY (team_leader_id) REFERENCES crm_users(id) ON DELETE SET NULL,
  ADD CONSTRAINT crm_teams_manager_fk FOREIGN KEY (manager_id) REFERENCES crm_users(id) ON DELETE SET NULL;

-- [CRM-LOCAL] Email verification for customer portal accounts (blueprint §11 "verified email").
CREATE TABLE email_verification_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,          -- SHA-256 of the token; raw token never stored
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT email_tokens_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE
);

CREATE TABLE agent_assignments (                -- agent <-> customer ownership ("My customers")
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  agent_id INT NOT NULL,
  assigned_by INT NULL,
  assigned_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  note VARCHAR(255) NULL,
  INDEX agent_assignments_active_idx (agent_id, ended_at),
  INDEX agent_assignments_customer_idx (customer_id, ended_at),
  CONSTRAINT agent_assignments_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT agent_assignments_agent_fk FOREIGN KEY (agent_id) REFERENCES crm_users(id),
  CONSTRAINT agent_assignments_by_fk FOREIGN KEY (assigned_by) REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE customer_interactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  crm_user_id INT NULL,
  interaction_type ENUM('call','visit','sms','email','chat','portal','note') NOT NULL,
  direction ENUM('inbound','outbound','internal') NOT NULL,
  subject VARCHAR(150) NOT NULL,
  summary TEXT NULL,
  related_type ENUM('case','inquiry','order','sale','follow_up','campaign') NULL,
  related_id INT NULL,
  occurred_at DATETIME NOT NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX customer_interactions_customer_idx (customer_id, occurred_at),
  CONSTRAINT customer_interactions_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT customer_interactions_user_fk FOREIGN KEY (crm_user_id) REFERENCES crm_users(id) ON DELETE SET NULL
);

-- -------------------------------------------------------------------------------------
-- 4. Sales (CRM owns order and sale source records)
-- -------------------------------------------------------------------------------------
CREATE TABLE campaigns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  channel ENUM('in_store','sms','email','social','portal','mixed') NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('draft','active','ended','cancelled') NOT NULL DEFAULT 'draft',
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT campaigns_dates_chk CHECK (end_date >= start_date)
);

CREATE TABLE promotions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  promo_code VARCHAR(30) NOT NULL UNIQUE,
  campaign_id INT NULL,
  name VARCHAR(120) NOT NULL,
  promo_type ENUM('percent','fixed_amount') NOT NULL,
  value DECIMAL(12,2) NOT NULL,
  min_order_amount DECIMAL(12,2) NULL,
  applies_to ENUM('order','product','category') NOT NULL DEFAULT 'order',
  product_id VARCHAR(64) NULL,
  category_name VARCHAR(120) NULL,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  usage_limit INT NULL,
  status ENUM('draft','pending_approval','active','expired','cancelled') NOT NULL DEFAULT 'draft',
  created_by INT NULL,
  approved_by INT NULL,                         -- must differ from created_by
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT promotions_campaign_fk FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  CONSTRAINT promotions_value_chk CHECK (value > 0),
  CONSTRAINT promotions_self_approval_chk CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE discounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  discount_code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  discount_type ENUM('senior_citizen','pwd','loyalty','manual') NOT NULL,
  percent DECIMAL(5,2) NULL,
  amount DECIMAL(12,2) NULL,
  requires_approval TINYINT(1) NOT NULL DEFAULT 0,
  requires_id_reference TINYINT(1) NOT NULL DEFAULT 0, -- SC/PWD ID number on the order
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT discounts_value_chk CHECK ((percent IS NOT NULL) <> (amount IS NOT NULL))
);

CREATE TABLE sales_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id CHAR(36) NOT NULL UNIQUE,            -- shared UUID
  order_no VARCHAR(24) NOT NULL UNIQUE,         -- SO-YYYYMMDD-0001
  customer_id INT NOT NULL,
  agent_id INT NULL,
  team_id INT NULL,
  channel ENUM('walk_in','phone','portal','delivery') NOT NULL,
  fulfillment ENUM('in_store','pickup','delivery') NOT NULL DEFAULT 'in_store',
  delivery_address_id INT NULL,
  status ENUM('draft','pending_stock','confirmed','completed','cancelled') NOT NULL DEFAULT 'draft',
  reservation_status ENUM('none','requested','reserved','partially_reserved','failed','released','issued') NOT NULL DEFAULT 'none',
  inventory_reservation_ref VARCHAR(64) NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  grand_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'PHP',
  correlation_id CHAR(36) NOT NULL,             -- traces the sale through Inventory and Accounting
  confirmed_at DATETIME NULL,
  completed_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  cancel_reason VARCHAR(255) NULL,
  created_by INT NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX sales_orders_status_idx (status, created_at),
  INDEX sales_orders_customer_idx (customer_id),
  INDEX sales_orders_agent_idx (agent_id),
  CONSTRAINT sales_orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT sales_orders_agent_fk FOREIGN KEY (agent_id) REFERENCES crm_users(id) ON DELETE SET NULL,
  CONSTRAINT sales_orders_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE SET NULL,
  CONSTRAINT sales_orders_address_fk FOREIGN KEY (delivery_address_id) REFERENCES customer_addresses(id) ON DELETE SET NULL
);

CREATE TABLE sales_order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sales_order_id INT NOT NULL,
  line_no SMALLINT NOT NULL,
  product_id VARCHAR(64) NOT NULL,              -- Inventory product_id
  sku VARCHAR(64) NOT NULL,
  product_name VARCHAR(200) NOT NULL,           -- snapshot at order time
  unit VARCHAR(30) NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,            -- snapshot of Inventory price; not editable in CRM
  is_vatable TINYINT(1) NOT NULL DEFAULT 1,
  promotion_id INT NULL,
  discount_id INT NULL,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(12,2) NOT NULL,
  UNIQUE KEY sales_order_items_line_unique (sales_order_id, line_no),
  CONSTRAINT sales_order_items_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
  CONSTRAINT sales_order_items_promo_fk FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE SET NULL,
  CONSTRAINT sales_order_items_discount_fk FOREIGN KEY (discount_id) REFERENCES discounts(id) ON DELETE SET NULL,
  CONSTRAINT sales_order_items_qty_chk CHECK (quantity > 0),
  CONSTRAINT sales_order_items_price_chk CHECK (unit_price >= 0)
);

CREATE TABLE payment_references (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sales_order_id INT NOT NULL,
  method ENUM('cash','gcash','maya','card','bank_transfer','cod','other') NOT NULL,
  reference_no VARCHAR(80) NULL,                -- OR number / e-wallet reference
  amount DECIMAL(12,2) NOT NULL,
  paid_at DATETIME NOT NULL,
  status ENUM('recorded','verified','voided') NOT NULL DEFAULT 'recorded',
  recorded_by INT NULL,
  void_reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payment_references_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  CONSTRAINT payment_references_amount_chk CHECK (amount > 0)
);

CREATE TABLE sales_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id CHAR(36) NOT NULL UNIQUE,             -- shared UUID in SaleCompleted
  transaction_no VARCHAR(24) NOT NULL UNIQUE,   -- SALE-YYYYMMDD-0001
  sales_order_id INT NOT NULL UNIQUE,           -- one completed sale per order
  customer_id INT NOT NULL,
  gross_amount DECIMAL(12,2) NOT NULL,
  discount_total DECIMAL(12,2) NOT NULL,
  tax_total DECIMAL(12,2) NOT NULL,
  net_amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'PHP',
  status ENUM('completed','partially_refunded','refunded','cancelled','voided') NOT NULL DEFAULT 'completed',
  completed_at DATETIME NOT NULL,
  correlation_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL UNIQUE, -- 'SaleCompleted:<sale_id>'
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX sales_transactions_completed_idx (completed_at),
  CONSTRAINT sales_transactions_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  CONSTRAINT sales_transactions_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  refund_id CHAR(36) NOT NULL UNIQUE,
  refund_no VARCHAR(24) NOT NULL UNIQUE,
  sales_transaction_id INT NOT NULL,
  case_id INT NULL,                             -- complaint that led to the refund
  amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  return_items JSON NULL,                       -- [{product_id, quantity}] for Inventory
  status ENUM('requested','approved','rejected','recorded') NOT NULL DEFAULT 'requested',
  requested_by INT NOT NULL,
  approved_by INT NULL,
  approved_at DATETIME NULL,
  decision_reason VARCHAR(255) NULL,
  recorded_at DATETIME NULL,
  correlation_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT refunds_sale_fk FOREIGN KEY (sales_transaction_id) REFERENCES sales_transactions(id),
  CONSTRAINT refunds_amount_chk CHECK (amount > 0),
  CONSTRAINT refunds_self_approval_chk CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- -------------------------------------------------------------------------------------
-- 5. Customer service (inquiries and cases)
-- -------------------------------------------------------------------------------------
CREATE TABLE case_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  description VARCHAR(255) NULL,
  default_priority ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE inquiries (                        -- quick questions; may be converted to a case
  id INT AUTO_INCREMENT PRIMARY KEY,
  inquiry_no VARCHAR(24) NOT NULL UNIQUE,       -- INQ-YYYYMMDD-0001
  customer_id INT NOT NULL,
  channel ENUM('portal','phone','walk_in','sms','social','email') NOT NULL,
  subject VARCHAR(150) NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NULL,
  status ENUM('open','answered','converted','closed') NOT NULL DEFAULT 'open',
  handled_by INT NULL,
  converted_case_id INT NULL,
  answered_at DATETIME NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX inquiries_status_idx (status, created_at),
  CONSTRAINT inquiries_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT inquiries_handler_fk FOREIGN KEY (handled_by) REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE customer_cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_no VARCHAR(24) NOT NULL UNIQUE,          -- JVT-YYYYMMDD-0001 (kept from current build)
  customer_id INT NOT NULL,
  case_type ENUM('complaint','service_request','inquiry','feedback') NOT NULL,
  category_id INT NOT NULL,
  subject VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  priority ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  status ENUM('open','assigned','in_progress','waiting_for_customer','escalated','resolved','closed') NOT NULL DEFAULT 'open',
  escalation_level TINYINT NOT NULL DEFAULT 0,  -- 0 agent, 1 team leader, 2 CRM manager
  channel ENUM('portal','phone','walk_in','sms','social','email') NOT NULL DEFAULT 'portal',
  team_id INT NULL,
  assigned_agent_id INT NULL,
  sales_order_id INT NULL,                      -- linked CRM order, if any
  order_reference VARCHAR(60) NULL,             -- free text the customer typed
  inquiry_id INT NULL,                          -- converted from inquiry
  first_response_due_at DATETIME NULL,
  resolution_due_at DATETIME NULL,
  first_response_at DATETIME NULL,
  resolved_at DATETIME NULL,
  closed_at DATETIME NULL,
  reopen_count INT NOT NULL DEFAULT 0,
  sla_breach_notified_at DATETIME NULL,
  created_by INT NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX customer_cases_status_idx (status),
  INDEX customer_cases_agent_idx (assigned_agent_id),
  INDEX customer_cases_team_idx (team_id),
  INDEX customer_cases_customer_idx (customer_id),
  INDEX customer_cases_created_idx (created_at),
  CONSTRAINT customer_cases_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT customer_cases_category_fk FOREIGN KEY (category_id) REFERENCES case_categories(id),
  CONSTRAINT customer_cases_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE SET NULL,
  CONSTRAINT customer_cases_agent_fk FOREIGN KEY (assigned_agent_id) REFERENCES crm_users(id) ON DELETE SET NULL,
  CONSTRAINT customer_cases_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL,
  CONSTRAINT customer_cases_inquiry_fk FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE SET NULL,
  CONSTRAINT customer_cases_level_chk CHECK (escalation_level BETWEEN 0 AND 2)
);

ALTER TABLE inquiries
  ADD CONSTRAINT inquiries_case_fk FOREIGN KEY (converted_case_id) REFERENCES customer_cases(id) ON DELETE SET NULL;
ALTER TABLE refunds
  ADD CONSTRAINT refunds_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE SET NULL;

CREATE TABLE case_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  agent_id INT NOT NULL,
  team_id INT NULL,
  assigned_by INT NULL,
  assigned_at DATETIME NOT NULL,
  unassigned_at DATETIME NULL,
  note VARCHAR(255) NULL,
  INDEX case_assignments_case_idx (case_id),
  INDEX case_assignments_agent_idx (agent_id),
  CONSTRAINT case_assignments_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
  CONSTRAINT case_assignments_agent_fk FOREIGN KEY (agent_id) REFERENCES crm_users(id),
  CONSTRAINT case_assignments_by_fk FOREIGN KEY (assigned_by) REFERENCES crm_users(id) ON DELETE SET NULL
);

-- [CRM-LOCAL] Escalation chain Agent -> Team Leader -> CRM Manager with actor, reason, time.
CREATE TABLE case_escalations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  from_level TINYINT NOT NULL,
  to_level TINYINT NOT NULL,
  escalated_by INT NOT NULL,
  escalated_to INT NULL,                        -- the team leader / manager who receives it
  reason VARCHAR(255) NOT NULL,
  outcome ENUM('pending','handled','returned') NOT NULL DEFAULT 'pending',
  handled_by INT NULL,
  handled_at DATETIME NULL,
  handling_note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX case_escalations_case_idx (case_id),
  INDEX case_escalations_target_idx (escalated_to, outcome),
  CONSTRAINT case_escalations_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
  CONSTRAINT case_escalations_by_fk FOREIGN KEY (escalated_by) REFERENCES crm_users(id),
  CONSTRAINT case_escalations_to_fk FOREIGN KEY (escalated_to) REFERENCES crm_users(id) ON DELETE SET NULL,
  CONSTRAINT case_escalations_level_chk CHECK (to_level = from_level + 1 AND to_level <= 2)
);

-- [CRM-LOCAL] Field-level history shown on the case page (status, priority, category, assignment).
CREATE TABLE case_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  changed_by INT NULL,                          -- NULL = system job
  field ENUM('created','status','priority','category','assignment','escalation') NOT NULL,
  old_value VARCHAR(120) NULL,
  new_value VARCHAR(120) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX case_status_history_case_idx (case_id, created_at),
  CONSTRAINT case_status_history_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
  CONSTRAINT case_status_history_user_fk FOREIGN KEY (changed_by) REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE case_comments (                    -- public replies and internal notes
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  author_id INT NOT NULL,
  visibility ENUM('public','internal') NOT NULL DEFAULT 'public',
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX case_comments_case_idx (case_id, created_at),
  CONSTRAINT case_comments_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
  CONSTRAINT case_comments_author_fk FOREIGN KEY (author_id) REFERENCES crm_users(id)
);

CREATE TABLE attachments (                      -- generic, stored outside public/
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type ENUM('case','case_comment','inquiry','customer','sales_order','refund') NOT NULL,
  entity_id INT NOT NULL,
  uploaded_by INT NOT NULL,
  original_name VARCHAR(200) NOT NULL,
  stored_name VARCHAR(80) NOT NULL UNIQUE,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes INT NOT NULL,
  visibility ENUM('public','internal') NOT NULL DEFAULT 'public',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX attachments_entity_idx (entity_type, entity_id),
  CONSTRAINT attachments_user_fk FOREIGN KEY (uploaded_by) REFERENCES crm_users(id)
);

-- [CRM-LOCAL] Unread markers per user and case.
CREATE TABLE case_reads (
  user_id INT NOT NULL,
  case_id INT NOT NULL,
  last_read_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, case_id),
  CONSTRAINT case_reads_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE,
  CONSTRAINT case_reads_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE
);

-- [CRM-LOCAL] Customer satisfaction rating, one per case (supplement E "Complaint / Feedback").
CREATE TABLE case_feedback (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL UNIQUE,
  customer_id INT NOT NULL,
  rating TINYINT NOT NULL,
  comment TEXT NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT case_feedback_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
  CONSTRAINT case_feedback_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT case_feedback_rating_chk CHECK (rating BETWEEN 1 AND 5)
);

-- [CRM-LOCAL] Agent reply templates (kept from the current build).
CREATE TABLE response_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  category_id INT NULL,
  body TEXT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT response_templates_category_fk FOREIGN KEY (category_id) REFERENCES case_categories(id) ON DELETE SET NULL,
  CONSTRAINT response_templates_user_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL
);

CREATE TABLE follow_up_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  case_id INT NULL,
  sales_order_id INT NULL,
  assigned_to INT NOT NULL,
  created_by INT NULL,
  title VARCHAR(150) NOT NULL,
  notes TEXT NULL,
  due_at DATETIME NOT NULL,
  priority ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  status ENUM('pending','done','cancelled') NOT NULL DEFAULT 'pending',
  completed_at DATETIME NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX follow_up_tasks_assignee_idx (assigned_to, status, due_at),
  CONSTRAINT follow_up_tasks_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT follow_up_tasks_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE SET NULL,
  CONSTRAINT follow_up_tasks_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL,
  CONSTRAINT follow_up_tasks_assignee_fk FOREIGN KEY (assigned_to) REFERENCES crm_users(id)
);

CREATE TABLE service_targets (                  -- SLA targets (replaces settings sla_* rows)
  id INT AUTO_INCREMENT PRIMARY KEY,
  priority ENUM('low','medium','high','urgent') NOT NULL,
  team_id INT NULL,                             -- NULL = default for all teams
  first_response_minutes INT NOT NULL,
  resolution_minutes INT NOT NULL,
  effective_from DATETIME NOT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY service_targets_unique (priority, team_id, effective_from),
  CONSTRAINT service_targets_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE CASCADE,
  CONSTRAINT service_targets_order_chk CHECK (first_response_minutes > 0 AND resolution_minutes >= first_response_minutes)
);

CREATE TABLE crm_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type ENUM('new_case','assignment','new_reply','status_change','resolved','sla_overdue','escalation',
            'feedback','order','follow_up','approval','integration','account') NOT NULL,
  title VARCHAR(150) NOT NULL,
  message VARCHAR(255) NULL,
  link VARCHAR(255) NULL,
  related_type VARCHAR(30) NULL,
  related_id INT NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX crm_notifications_user_idx (user_id, read_at),
  CONSTRAINT crm_notifications_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE
);

-- -------------------------------------------------------------------------------------
-- 6. Employee request approvals received from HR/ESS  [CRM-LOCAL — pending team confirmation]
-- -------------------------------------------------------------------------------------
CREATE TABLE employee_request_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(64) NOT NULL UNIQUE,       -- HR/ESS request ID
  request_type ENUM('leave','attendance_correction','overtime') NOT NULL,
  employee_id VARCHAR(64) NOT NULL,             -- requester (HR ID)
  approver_user_id INT NULL,                    -- resolved CRM approver; NULL -> exception queue
  status ENUM('pending','approved','rejected','returned','exception') NOT NULL DEFAULT 'pending',
  summary VARCHAR(255) NOT NULL,
  payload JSON NOT NULL,                        -- dates/hours/reason as sent by HR
  decided_by INT NULL,
  decided_at DATETIME NULL,
  decision_reason VARCHAR(255) NULL,
  decision_event_id CHAR(36) NULL,              -- outbox event sent back to HR
  received_at DATETIME NOT NULL,
  INDEX employee_request_approvals_queue_idx (approver_user_id, status),
  CONSTRAINT era_approver_fk FOREIGN KEY (approver_user_id) REFERENCES crm_users(id) ON DELETE SET NULL,
  CONSTRAINT era_decider_fk FOREIGN KEY (decided_by) REFERENCES crm_users(id) ON DELETE SET NULL
);

-- -------------------------------------------------------------------------------------
-- 7. Integration (section 13)
-- -------------------------------------------------------------------------------------
CREATE TABLE integration_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id CHAR(36) NOT NULL UNIQUE,
  event_type VARCHAR(60) NOT NULL,              -- OrderConfirmed, SaleCompleted, SaleCancelled, RefundRecorded
  schema_version INT NOT NULL DEFAULT 1,
  source VARCHAR(40) NOT NULL DEFAULT 'johnvivz_crm',
  target VARCHAR(40) NOT NULL,                  -- johnvivz_inventory | johnvivz_accounting | johnvivz_hr
  occurred_at DATETIME(3) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  correlation_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  payload JSON NOT NULL,                        -- full envelope as sent
  status ENUM('pending','sent','failed','dead','skipped_disabled','mock_delivered') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY integration_outbox_idem_unique (target, idempotency_key),
  INDEX integration_outbox_dispatch_idx (status, next_attempt_at),
  INDEX integration_outbox_corr_idx (correlation_id)
);

CREATE TABLE integration_inbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id CHAR(36) NOT NULL UNIQUE,            -- duplicates are rejected here
  event_type VARCHAR(60) NOT NULL,
  schema_version INT NOT NULL,
  source VARCHAR(40) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  correlation_id CHAR(36) NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('received','processed','failed','dead','ignored') NOT NULL DEFAULT 'received',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  is_mock TINYINT(1) NOT NULL DEFAULT 0,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  UNIQUE KEY integration_inbox_idem_unique (source, idempotency_key),
  INDEX integration_inbox_status_idx (status, received_at)
);

CREATE TABLE integration_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  direction ENUM('outbound_event','inbound_event','api_call','api_served') NOT NULL,
  system VARCHAR(40) NOT NULL,                  -- johnvivz_inventory, johnvivz_hr, ...
  endpoint VARCHAR(255) NULL,
  http_method VARCHAR(10) NULL,
  event_id CHAR(36) NULL,
  correlation_id CHAR(36) NULL,
  http_status SMALLINT NULL,
  duration_ms INT NULL,
  success TINYINT(1) NOT NULL,
  mode ENUM('disabled','mock','live') NOT NULL,
  message VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX integration_logs_created_idx (created_at),
  INDEX integration_logs_corr_idx (correlation_id)
);

-- -------------------------------------------------------------------------------------
-- 8. Analytics forecasts (section 10)  [CRM-LOCAL]
-- -------------------------------------------------------------------------------------
CREATE TABLE forecast_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  metric ENUM('daily_sales_amount','daily_order_count','daily_case_count') NOT NULL,
  method VARCHAR(60) NOT NULL,                  -- e.g. 'moving_average_7', 'linear_trend', 'seasonal_naive_7'
  method_version VARCHAR(20) NOT NULL,
  input_from DATE NOT NULL,
  input_to DATE NOT NULL,
  horizon_days INT NOT NULL,
  error_metric VARCHAR(20) NOT NULL,            -- 'MAPE' or 'MAE'
  error_value DECIMAL(12,4) NULL,               -- backtest error on the last N input days
  excluded_note VARCHAR(255) NOT NULL,          -- what was excluded (cancelled, voided, demo...)
  generated_by INT NULL,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE forecast_values (
  forecast_run_id INT NOT NULL,
  period_date DATE NOT NULL,
  estimate DECIMAL(14,2) NOT NULL,
  lower_bound DECIMAL(14,2) NULL,
  upper_bound DECIMAL(14,2) NULL,
  PRIMARY KEY (forecast_run_id, period_date),
  CONSTRAINT forecast_values_run_fk FOREIGN KEY (forecast_run_id) REFERENCES forecast_runs(id) ON DELETE CASCADE
);

-- -------------------------------------------------------------------------------------
-- 9. Audit (section 11) — append-only
-- -------------------------------------------------------------------------------------
CREATE TABLE crm_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_user_id INT NULL,                       -- NULL = system / integration
  actor_role VARCHAR(30) NULL,
  action VARCHAR(60) NOT NULL,
  record_type VARCHAR(40) NULL,
  record_id VARCHAR(64) NULL,
  reason VARCHAR(255) NULL,
  before_values JSON NULL,
  after_values JSON NULL,
  ip_address VARCHAR(45) NULL,
  correlation_id CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX crm_audit_logs_created_idx (created_at),
  INDEX crm_audit_logs_record_idx (record_type, record_id)
);

DELIMITER $$
CREATE TRIGGER crm_audit_logs_block_update BEFORE UPDATE ON crm_audit_logs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_audit_logs is append-only';
$$
CREATE TRIGGER crm_audit_logs_block_delete BEFORE DELETE ON crm_audit_logs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_audit_logs is append-only';
$$
DELIMITER ;

-- Production hardening (documented, run by the DBA): the application account gets only
-- SELECT, INSERT on crm_audit_logs:
--   GRANT SELECT, INSERT ON johnvivz_crm_db.crm_audit_logs TO 'crm_app'@'%';

-- -------------------------------------------------------------------------------------
-- 10. Optional — only if the CRM master prompt / your approval keeps them
-- -------------------------------------------------------------------------------------
-- cart_records / cart_items       (customer portal ordering, if portal ordering is enabled)
-- loyalty_accounts / loyalty_ledger (if loyalty is approved)
