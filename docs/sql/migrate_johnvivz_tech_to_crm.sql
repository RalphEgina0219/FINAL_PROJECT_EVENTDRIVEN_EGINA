-- NOT USED (decision D3, 2026-11-11): johnvivz_crm_db was created fresh and reseeded; no data was copied.
-- Kept for the P0 review record only.
-- =====================================================================================
-- Data move: johnvivz_tech (current CRM database)  ->  johnvivz_crm_db (blueprint name)
-- Status: PROPOSAL. Not executed.
-- Both databases belong to the CRM application, so copying between them does not break the
-- blueprint rule "never read another application's database".
-- Pre-conditions:
--   1. mysqldump backup of johnvivz_tech taken and verified.
--   2. johnvivz_crm_db created by the new migration set (crm_schema_proposal.sql), still empty.
--   3. App stopped (no writes during the copy).
-- IDs are preserved: crm_users.id = users.id, customers.id = users.id (customer role),
-- customer_cases.id = support_tickets.id, case_comments.id = ticket_responses.id, etc.
-- The old database is NOT modified and NOT dropped; it stays as the rollback copy.
-- =====================================================================================
SET @now := NOW();
START TRANSACTION;

-- 1. Settings and SLA targets ----------------------------------------------------------
INSERT INTO johnvivz_crm_db.crm_settings (setting_key, setting_value, description, updated_at)
SELECT setting_key, setting_value, description, updated_at
FROM johnvivz_tech.settings
WHERE setting_key IN ('auto_close_days', 'reopen_window_days');

INSERT INTO johnvivz_crm_db.service_targets (priority, team_id, first_response_minutes, resolution_minutes, effective_from)
SELECT p.priority, NULL,
       CAST(fr.setting_value AS UNSIGNED) * 60,
       CAST(rs.setting_value AS UNSIGNED) * 60,
       @now
FROM (SELECT 'urgent' AS priority UNION ALL SELECT 'high' UNION ALL SELECT 'medium' UNION ALL SELECT 'low') p
JOIN johnvivz_tech.settings fr ON fr.setting_key = CONCAT('sla_first_response_hours_', p.priority)
JOIN johnvivz_tech.settings rs ON rs.setting_key = CONCAT('sla_resolution_hours_', p.priority);

-- 2. Customers (master record now lives in customers, not users) ----------------------
INSERT INTO johnvivz_crm_db.customers
  (id, customer_id, customer_no, first_name, last_name, email, mobile, normalized_email, normalized_mobile,
   source, status, is_demo, created_at, updated_at)
SELECT u.id,
       UUID(),
       CONCAT('CUS-', LPAD(u.id, 6, '0')),
       TRIM(SUBSTRING(u.name, 1, CHAR_LENGTH(u.name) - CHAR_LENGTH(SUBSTRING_INDEX(u.name, ' ', -1)))),
       SUBSTRING_INDEX(u.name, ' ', -1),
       u.email,
       c.phone,
       LOWER(TRIM(u.email)),
       NULLIF(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', ''), ''),
       'migration',
       IF(u.is_active = 1, 'active', 'inactive'),
       u.is_demo, u.createdAt, u.updatedAt
FROM johnvivz_tech.users u
LEFT JOIN johnvivz_tech.customers c ON c.user_id = u.id
WHERE u.role = 'customer';
-- Single-word names: first_name becomes '' -> fix to the full name.
UPDATE johnvivz_crm_db.customers SET first_name = last_name WHERE first_name = '';

INSERT INTO johnvivz_crm_db.customer_contacts (customer_id, contact_type, value, is_primary)
SELECT u.id, 'email', u.email, 1 FROM johnvivz_tech.users u WHERE u.role = 'customer'
UNION ALL
SELECT c.user_id, 'mobile', c.phone, 1 FROM johnvivz_tech.customers c WHERE c.phone IS NOT NULL AND c.phone <> '';

INSERT INTO johnvivz_crm_db.customer_addresses (customer_id, label, line1, is_default)
SELECT c.user_id, 'Home', c.address, 1 FROM johnvivz_tech.customers c WHERE c.address IS NOT NULL AND c.address <> '';

-- Consent: existing customers registered before consent capture -> recorded as unknown via note,
-- no consent row is invented. They are asked to accept the privacy notice at next sign-in.

-- 3. Staff identity placeholders (HR is not live yet) -----------------------------------
-- Each existing staff user gets a clearly labelled MOCK employee reference. When HR goes live,
-- EmployeeCreated events replace these and crm_users.employee_id is re-linked by work email.
INSERT INTO johnvivz_crm_db.employee_references
  (employee_id, full_name, work_email, employment_status, source, is_mock, last_synced_at)
SELECT CONCAT('MOCK-EMP-', LPAD(u.id, 4, '0')), u.name, u.email,
       IF(u.is_active = 1, 'active', 'inactive'), 'mock_hr', 1, @now
FROM johnvivz_tech.users u WHERE u.role IN ('admin', 'manager', 'agent');

-- 4. CRM users (roles: admin+manager -> crm_manager; agent -> agent; customer -> customer) --
INSERT INTO johnvivz_crm_db.crm_users
  (id, user_type, role, employee_id, customer_ref_id, email, password_hash, display_name,
   is_active, is_available, email_verified_at, last_login_at, is_demo, created_at, updated_at)
SELECT u.id,
       IF(u.role = 'customer', 'customer', 'staff'),
       CASE u.role WHEN 'customer' THEN 'customer' WHEN 'agent' THEN 'agent' ELSE 'crm_manager' END,
       IF(u.role = 'customer', NULL, CONCAT('MOCK-EMP-', LPAD(u.id, 4, '0'))),
       IF(u.role = 'customer', u.id, NULL),
       u.email, u.password, u.name,
       u.is_active,
       COALESCE(sa.is_available, 1),
       IF(u.role = 'customer', NULL, @now),          -- staff email verified by HR; customers must verify
       u.last_login_at, u.is_demo, u.createdAt, u.updatedAt
FROM johnvivz_tech.users u
LEFT JOIN johnvivz_tech.support_agents sa ON sa.user_id = u.id;
-- NOTE: existing customer accounts get email_verified_at = NULL. Proposal: treat accounts created
-- before the move as verified (UPDATE ... SET email_verified_at = createdAt) — your decision (D7).

-- One default team so Team Leader scoping works; promote a Team Leader after the move (D3).
INSERT INTO johnvivz_crm_db.crm_teams (team_code, name, manager_id)
SELECT 'TEAM-01', 'Customer Care Team 1', MIN(id) FROM johnvivz_crm_db.crm_users WHERE role = 'crm_manager';
UPDATE johnvivz_crm_db.crm_users SET team_id = (SELECT id FROM johnvivz_crm_db.crm_teams WHERE team_code = 'TEAM-01')
WHERE role IN ('agent', 'team_leader');

-- 5. Categories, templates -------------------------------------------------------------
INSERT INTO johnvivz_crm_db.case_categories (id, name, description, is_active, created_at, updated_at)
SELECT id, name, description, is_active, created_at, updated_at FROM johnvivz_tech.ticket_categories;

INSERT INTO johnvivz_crm_db.response_templates (id, title, category_id, body, is_active, created_by, created_at, updated_at)
SELECT id, title, category_id, body, is_active, created_by, created_at, updated_at FROM johnvivz_tech.response_templates;

-- 6. Cases (support_tickets -> customer_cases) ------------------------------------------
INSERT INTO johnvivz_crm_db.customer_cases
  (id, case_no, customer_id, case_type, category_id, subject, description, priority, status, escalation_level,
   channel, team_id, assigned_agent_id, order_reference, first_response_due_at, resolution_due_at,
   first_response_at, resolved_at, closed_at, reopen_count, sla_breach_notified_at, created_by, is_demo,
   created_at, updated_at)
SELECT t.id, t.ticket_no, t.customer_id, t.concern_type, t.category_id, t.subject, t.description, t.priority,
       CASE t.status
         WHEN 'open'        THEN IF(t.assigned_agent_id IS NULL, 'open', 'assigned')
         WHEN 'in_progress' THEN 'in_progress'
         WHEN 'pending'     THEN 'waiting_for_customer'
         WHEN 'resolved'    THEN 'resolved'
         WHEN 'closed'      THEN 'closed'
         WHEN 'reopened'    THEN IF(t.assigned_agent_id IS NULL, 'open', 'in_progress')
       END,
       0, 'portal',
       IF(t.assigned_agent_id IS NULL, NULL, (SELECT id FROM johnvivz_crm_db.crm_teams WHERE team_code = 'TEAM-01')),
       t.assigned_agent_id, t.order_reference, t.first_response_due_at, t.resolution_due_at,
       t.first_response_at, t.resolved_at, t.closed_at, t.reopen_count, t.sla_breach_notified_at,
       t.customer_id, t.is_demo, t.created_at, t.updated_at
FROM johnvivz_tech.support_tickets t;

INSERT INTO johnvivz_crm_db.number_sequences (scope, seq_date, last_no)
SELECT 'case', seq_date, last_no FROM johnvivz_tech.ticket_daily_sequences;

INSERT INTO johnvivz_crm_db.case_comments (id, case_id, author_id, visibility, body, created_at, updated_at)
SELECT id, ticket_id, user_id, visibility, message, created_at, updated_at FROM johnvivz_tech.ticket_responses;

INSERT INTO johnvivz_crm_db.attachments
  (entity_type, entity_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, visibility, created_at)
SELECT IF(a.response_id IS NULL, 'case', 'case_comment'), COALESCE(a.response_id, a.ticket_id),
       a.uploaded_by, a.original_name, a.stored_name, a.mime_type, a.size_bytes, a.visibility, a.created_at
FROM johnvivz_tech.ticket_attachments a;

INSERT INTO johnvivz_crm_db.case_assignments (id, case_id, agent_id, team_id, assigned_by, assigned_at, unassigned_at, note)
SELECT a.id, a.ticket_id, a.agent_id, (SELECT id FROM johnvivz_crm_db.crm_teams WHERE team_code = 'TEAM-01'),
       a.assigned_by, a.assigned_at, a.unassigned_at, a.note
FROM johnvivz_tech.ticket_assignments a;

INSERT INTO johnvivz_crm_db.case_status_history (id, case_id, changed_by, field, old_value, new_value, note, created_at)
SELECT h.id, h.ticket_id, h.changed_by, h.field,
       CASE WHEN h.field IN ('status','created') THEN
         CASE h.old_value WHEN 'pending' THEN 'waiting_for_customer' WHEN 'reopened' THEN 'in_progress' ELSE h.old_value END
       ELSE h.old_value END,
       CASE WHEN h.field IN ('status','created') THEN
         CASE h.new_value WHEN 'pending' THEN 'waiting_for_customer' WHEN 'reopened' THEN 'in_progress' ELSE h.new_value END
       ELSE h.new_value END,
       IF(h.field = 'status' AND h.new_value = 'reopened', CONCAT('Reopened. ', COALESCE(h.note, '')), h.note),
       h.created_at
FROM johnvivz_tech.ticket_status_history h;

INSERT INTO johnvivz_crm_db.case_feedback (id, case_id, customer_id, rating, comment, is_demo, created_at)
SELECT id, ticket_id, customer_id, rating, comment, is_demo, created_at FROM johnvivz_tech.feedback;

INSERT INTO johnvivz_crm_db.case_reads (user_id, case_id, last_read_at)
SELECT user_id, ticket_id, last_read_at FROM johnvivz_tech.ticket_reads;

-- 7. Notifications ----------------------------------------------------------------------
INSERT INTO johnvivz_crm_db.crm_notifications (id, user_id, type, title, message, link, related_type, related_id, read_at, created_at)
SELECT n.id, n.user_id,
       CASE n.type WHEN 'new_ticket' THEN 'new_case' ELSE n.type END,
       REPLACE(n.title, 'ticket', 'case'), n.message,
       REPLACE(n.link, '/tickets/', '/cases/'),
       IF(n.ticket_id IS NULL, NULL, 'case'), n.ticket_id, n.read_at, n.created_at
FROM johnvivz_tech.notifications n;

-- 8. Audit history (activity_logs -> crm_audit_logs) --------------------------------------
INSERT INTO johnvivz_crm_db.crm_audit_logs
  (actor_user_id, actor_role, action, record_type, record_id, reason, ip_address, created_at)
SELECT l.user_id, u.role, l.action, l.entity_type, CAST(l.entity_id AS CHAR), l.details, l.ip_address, l.created_at
FROM johnvivz_tech.activity_logs l LEFT JOIN johnvivz_tech.users u ON u.id = l.user_id
ORDER BY l.id;

INSERT INTO johnvivz_crm_db.crm_audit_logs (action, record_type, reason, created_at)
VALUES ('database_migrated', 'system', 'Data copied from johnvivz_tech to johnvivz_crm_db', @now);

COMMIT;

-- =====================================================================================
-- Verification — every pair must match before switching .env to johnvivz_crm_db
-- =====================================================================================
SELECT 'customers'       AS item, (SELECT COUNT(*) FROM johnvivz_tech.users WHERE role='customer') AS old_count, (SELECT COUNT(*) FROM johnvivz_crm_db.customers) AS new_count
UNION ALL SELECT 'staff users',  (SELECT COUNT(*) FROM johnvivz_tech.users WHERE role<>'customer'), (SELECT COUNT(*) FROM johnvivz_crm_db.crm_users WHERE user_type='staff')
UNION ALL SELECT 'cases',        (SELECT COUNT(*) FROM johnvivz_tech.support_tickets),     (SELECT COUNT(*) FROM johnvivz_crm_db.customer_cases)
UNION ALL SELECT 'comments',     (SELECT COUNT(*) FROM johnvivz_tech.ticket_responses),    (SELECT COUNT(*) FROM johnvivz_crm_db.case_comments)
UNION ALL SELECT 'attachments',  (SELECT COUNT(*) FROM johnvivz_tech.ticket_attachments),  (SELECT COUNT(*) FROM johnvivz_crm_db.attachments)
UNION ALL SELECT 'assignments',  (SELECT COUNT(*) FROM johnvivz_tech.ticket_assignments),  (SELECT COUNT(*) FROM johnvivz_crm_db.case_assignments)
UNION ALL SELECT 'history',      (SELECT COUNT(*) FROM johnvivz_tech.ticket_status_history), (SELECT COUNT(*) FROM johnvivz_crm_db.case_status_history)
UNION ALL SELECT 'feedback',     (SELECT COUNT(*) FROM johnvivz_tech.feedback),            (SELECT COUNT(*) FROM johnvivz_crm_db.case_feedback)
UNION ALL SELECT 'notifications',(SELECT COUNT(*) FROM johnvivz_tech.notifications),       (SELECT COUNT(*) FROM johnvivz_crm_db.crm_notifications)
UNION ALL SELECT 'audit (+1)',   (SELECT COUNT(*) FROM johnvivz_tech.activity_logs) + 1,   (SELECT COUNT(*) FROM johnvivz_crm_db.crm_audit_logs);

-- Spot check: status mapping and ownership survived.
SELECT t.ticket_no, t.status AS old_status, c.status AS new_status, t.customer_id = c.customer_id AS same_customer
FROM johnvivz_tech.support_tickets t JOIN johnvivz_crm_db.customer_cases c ON c.id = t.id
ORDER BY t.id LIMIT 10;
