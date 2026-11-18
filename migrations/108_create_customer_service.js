/*
 * 108 — customer service (blueprint supplement E "Engagement" + "Work management"; master prompt §VI)
 * case_categories, inquiries, customer_cases, case_assignments, ticket_escalations (master prompt name),
 * case_status_history, case_comments, attachments, case_reads, response_templates, follow_up_tasks,
 * service_targets, customer_ratings, customer_feedback (master prompt names).
 * Case statuses: Open, Assigned, In Progress, Waiting for Customer, Escalated, Resolved, Closed.
 * Escalation chain: Agent (level 0) -> Team Leader (level 1) -> CRM Manager (level 2).
 */
import { run, dropTables, dropForeignKeyIfExists, TS } from "./_sql.js";
import { config } from "../config/index.js";

// Reference data for a grocery store (not demo data); the CRM Manager can edit them.
const CATEGORIES = [
  ["Order Issue", "Missing, wrong or incomplete items in an order", "medium"],
  ["Product Quality", "Expired, spoiled or damaged products", "high"],
  ["Billing & Payment", "Overcharges, double charges, receipts and payment concerns", "high"],
  ["Delivery & Pickup", "Delivery schedule, late delivery and pickup concerns", "medium"],
  ["Returns & Refunds", "Product returns, exchanges and refund requests", "medium"],
  ["Product Inquiry", "Availability, prices and product information", "low"],
  ["Account & Loyalty", "Customer account, loyalty points and discounts", "low"],
  ["Store Service", "Staff conduct, store cleanliness and in-store experience", "medium"],
  ["General Inquiry", "Other questions and concerns", "low"],
];

const TEMPLATES = [
  ["Acknowledge concern", null, "Hi {customer_name}, thank you for contacting JOHNVIVZ. We received case {case_no} and {agent_name} is now looking into it. We'll update you soon."],
  ["Request photo and receipt", null, "Hi {customer_name}, to process case {case_no} faster, please reply with a photo of the item and a copy of your receipt. Thank you!"],
  ["Refund processed", "Returns & Refunds", "Hi {customer_name}, your refund for case {case_no} has been processed. It should reflect within 3–5 banking days. — {agent_name}"],
  ["Replacement scheduled", "Order Issue", "Hi {customer_name}, we've scheduled a replacement for the missing/wrong item(s) in case {case_no} at no extra cost."],
  ["Delivery rescheduled", "Delivery & Pickup", "Hi {customer_name}, your delivery for case {case_no} has been rescheduled as requested."],
];

export const up = async ({ sequelize }) => {
  await run(sequelize, [
    `CREATE TABLE case_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL UNIQUE,
      description VARCHAR(255) NULL,
      default_priority ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      ${TS}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE inquiries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inquiry_no VARCHAR(24) NOT NULL UNIQUE COMMENT 'INQ-YYYYMMDD-0001',
      customer_id INT NOT NULL,
      channel ENUM('portal','phone','walk_in','sms','social','email') NOT NULL,
      subject VARCHAR(150) NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NULL,
      status ENUM('open','answered','converted','closed') NOT NULL DEFAULT 'open',
      handled_by INT NULL,
      converted_case_id INT NULL,
      answered_at DATETIME NULL,
      created_by INT NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      INDEX inquiries_status_idx (status, created_at),
      CONSTRAINT inquiries_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT inquiries_handler_fk FOREIGN KEY (handled_by) REFERENCES crm_users(id) ON DELETE SET NULL,
      CONSTRAINT inquiries_created_by_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_cases (
      id INT AUTO_INCREMENT PRIMARY KEY,
      case_no VARCHAR(24) NOT NULL UNIQUE COMMENT 'JVT-YYYYMMDD-0001',
      customer_id INT NOT NULL,
      case_type ENUM('complaint','service_request','inquiry','feedback') NOT NULL,
      category_id INT NOT NULL,
      subject VARCHAR(150) NOT NULL,
      description TEXT NOT NULL,
      priority ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
      status ENUM('open','assigned','in_progress','waiting_for_customer','escalated','resolved','closed') NOT NULL DEFAULT 'open',
      escalation_level TINYINT NOT NULL DEFAULT 0 COMMENT '0 agent, 1 team leader, 2 CRM manager',
      channel ENUM('portal','phone','walk_in','sms','social','email') NOT NULL DEFAULT 'portal',
      team_id INT NULL,
      assigned_agent_id INT NULL,
      sales_order_id INT NULL COMMENT 'linked CRM order, if any',
      order_reference VARCHAR(60) NULL COMMENT 'receipt/order number typed by the customer',
      inquiry_id INT NULL COMMENT 'set when converted from an inquiry',
      first_response_due_at DATETIME NULL,
      resolution_due_at DATETIME NULL,
      first_response_at DATETIME NULL,
      resolved_at DATETIME NULL,
      closed_at DATETIME NULL,
      reopen_count INT NOT NULL DEFAULT 0,
      sla_breach_notified_at DATETIME NULL,
      created_by INT NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      ${TS},
      INDEX customer_cases_status_idx (status),
      INDEX customer_cases_agent_idx (assigned_agent_id),
      INDEX customer_cases_team_idx (team_id),
      INDEX customer_cases_customer_idx (customer_id),
      INDEX customer_cases_created_idx (created_at),
      CONSTRAINT customer_cases_level_chk CHECK (escalation_level BETWEEN 0 AND 2),
      CONSTRAINT customer_cases_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT customer_cases_category_fk FOREIGN KEY (category_id) REFERENCES case_categories(id),
      CONSTRAINT customer_cases_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE SET NULL,
      CONSTRAINT customer_cases_agent_fk FOREIGN KEY (assigned_agent_id) REFERENCES crm_users(id) ON DELETE SET NULL,
      CONSTRAINT customer_cases_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL,
      CONSTRAINT customer_cases_inquiry_fk FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE SET NULL,
      CONSTRAINT customer_cases_created_by_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `ALTER TABLE inquiries ADD CONSTRAINT inquiries_case_fk FOREIGN KEY (converted_case_id) REFERENCES customer_cases(id) ON DELETE SET NULL`,
    `ALTER TABLE refunds ADD CONSTRAINT refunds_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE SET NULL`,
    `CREATE TABLE case_assignments (
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
      CONSTRAINT case_assignments_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE SET NULL,
      CONSTRAINT case_assignments_by_fk FOREIGN KEY (assigned_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE ticket_escalations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      case_id INT NOT NULL,
      from_level TINYINT NOT NULL,
      to_level TINYINT NOT NULL,
      escalated_by INT NOT NULL,
      escalated_to INT NULL COMMENT 'team leader / CRM manager who receives it',
      reason VARCHAR(255) NOT NULL,
      outcome ENUM('pending','handled','returned','escalated') NOT NULL DEFAULT 'pending',
      handled_by INT NULL,
      handled_at DATETIME NULL,
      handling_note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX ticket_escalations_case_idx (case_id),
      INDEX ticket_escalations_target_idx (escalated_to, outcome),
      CONSTRAINT ticket_escalations_level_chk CHECK (to_level = from_level + 1 AND to_level BETWEEN 1 AND 2),
      CONSTRAINT ticket_escalations_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
      CONSTRAINT ticket_escalations_by_fk FOREIGN KEY (escalated_by) REFERENCES crm_users(id),
      CONSTRAINT ticket_escalations_to_fk FOREIGN KEY (escalated_to) REFERENCES crm_users(id) ON DELETE SET NULL,
      CONSTRAINT ticket_escalations_handler_fk FOREIGN KEY (handled_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE case_status_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      case_id INT NOT NULL,
      changed_by INT NULL COMMENT 'NULL = system job',
      field ENUM('created','status','priority','category','assignment','escalation') NOT NULL,
      old_value VARCHAR(120) NULL,
      new_value VARCHAR(120) NULL,
      note VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX case_status_history_case_idx (case_id, created_at),
      CONSTRAINT case_status_history_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
      CONSTRAINT case_status_history_user_fk FOREIGN KEY (changed_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE case_comments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      case_id INT NOT NULL,
      author_id INT NOT NULL,
      visibility ENUM('public','internal') NOT NULL DEFAULT 'public',
      body TEXT NOT NULL,
      ${TS},
      INDEX case_comments_case_idx (case_id, created_at),
      CONSTRAINT case_comments_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
      CONSTRAINT case_comments_author_fk FOREIGN KEY (author_id) REFERENCES crm_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE attachments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      entity_type ENUM('case','case_comment','inquiry','customer','sales_order','refund') NOT NULL,
      entity_id INT NOT NULL,
      case_id INT NULL COMMENT 'set for case and case_comment files so access follows the case',
      uploaded_by INT NOT NULL,
      original_name VARCHAR(200) NOT NULL,
      stored_name VARCHAR(80) NOT NULL UNIQUE,
      mime_type VARCHAR(120) NOT NULL,
      size_bytes INT NOT NULL,
      visibility ENUM('public','internal') NOT NULL DEFAULT 'public',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX attachments_entity_idx (entity_type, entity_id),
      INDEX attachments_case_idx (case_id),
      CONSTRAINT attachments_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE,
      CONSTRAINT attachments_user_fk FOREIGN KEY (uploaded_by) REFERENCES crm_users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE case_reads (
      user_id INT NOT NULL,
      case_id INT NOT NULL,
      last_read_at DATETIME NOT NULL,
      PRIMARY KEY (user_id, case_id),
      CONSTRAINT case_reads_user_fk FOREIGN KEY (user_id) REFERENCES crm_users(id) ON DELETE CASCADE,
      CONSTRAINT case_reads_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE response_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(100) NOT NULL,
      category_id INT NULL,
      body TEXT NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      ${TS},
      CONSTRAINT response_templates_category_fk FOREIGN KEY (category_id) REFERENCES case_categories(id) ON DELETE SET NULL,
      CONSTRAINT response_templates_user_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE follow_up_tasks (
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
      ${TS},
      INDEX follow_up_tasks_assignee_idx (assigned_to, status, due_at),
      CONSTRAINT follow_up_tasks_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT follow_up_tasks_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE SET NULL,
      CONSTRAINT follow_up_tasks_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL,
      CONSTRAINT follow_up_tasks_assignee_fk FOREIGN KEY (assigned_to) REFERENCES crm_users(id),
      CONSTRAINT follow_up_tasks_created_by_fk FOREIGN KEY (created_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE service_targets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      priority ENUM('low','medium','high','urgent') NOT NULL,
      team_id INT NULL COMMENT 'NULL = default for every team',
      first_response_minutes INT NOT NULL,
      resolution_minutes INT NOT NULL,
      effective_from DATETIME NOT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY service_targets_unique (priority, team_id, effective_from),
      CONSTRAINT service_targets_order_chk CHECK (first_response_minutes > 0 AND resolution_minutes >= first_response_minutes),
      CONSTRAINT service_targets_team_fk FOREIGN KEY (team_id) REFERENCES crm_teams(id) ON DELETE CASCADE,
      CONSTRAINT service_targets_user_fk FOREIGN KEY (updated_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_ratings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      subject_type ENUM('case','order') NOT NULL,
      case_id INT NULL UNIQUE,
      sales_order_id INT NULL UNIQUE,
      rating TINYINT NOT NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT customer_ratings_rating_chk CHECK (rating BETWEEN 1 AND 5),
      CONSTRAINT customer_ratings_subject_chk CHECK (
        (subject_type = 'case' AND case_id IS NOT NULL AND sales_order_id IS NULL) OR
        (subject_type = 'order' AND sales_order_id IS NOT NULL AND case_id IS NULL)),
      CONSTRAINT customer_ratings_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT customer_ratings_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id),
      CONSTRAINT customer_ratings_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE customer_feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      rating_id INT NULL UNIQUE,
      case_id INT NULL,
      sales_order_id INT NULL,
      feedback_type ENUM('service','product','store','suggestion','compliment','other') NOT NULL DEFAULT 'service',
      comment TEXT NOT NULL,
      status ENUM('new','reviewed','actioned') NOT NULL DEFAULT 'new',
      reviewed_by INT NULL,
      reviewed_at DATETIME NULL,
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX customer_feedback_status_idx (status, created_at),
      CONSTRAINT customer_feedback_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id),
      CONSTRAINT customer_feedback_rating_fk FOREIGN KEY (rating_id) REFERENCES customer_ratings(id) ON DELETE SET NULL,
      CONSTRAINT customer_feedback_case_fk FOREIGN KEY (case_id) REFERENCES customer_cases(id) ON DELETE SET NULL,
      CONSTRAINT customer_feedback_order_fk FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE SET NULL,
      CONSTRAINT customer_feedback_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES crm_users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]);

  for (const [name, description, priority] of CATEGORIES) {
    await sequelize.query("INSERT INTO case_categories (name, description, default_priority) VALUES (?, ?, ?)", { replacements: [name, description, priority] });
  }
  for (const [title, category, body] of TEMPLATES) {
    await sequelize.query(
      "INSERT INTO response_templates (title, category_id, body) VALUES (?, (SELECT id FROM case_categories WHERE name = ?), ?)",
      { replacements: [title, category, body] }
    );
  }
  for (const p of ["urgent", "high", "medium", "low"]) {
    await sequelize.query(
      "INSERT INTO service_targets (priority, team_id, first_response_minutes, resolution_minutes, effective_from) VALUES (?, NULL, ?, ?, '2000-01-01 00:00:00')",
      { replacements: [p, config.sla.firstResponseHours[p] * 60, config.sla.resolutionHours[p] * 60] }
    );
  }
};

export const down = async ({ sequelize }) => {
  await dropForeignKeyIfExists(sequelize, "refunds", "refunds_case_fk");
  await dropTables(sequelize, [
    "customer_feedback", "customer_ratings", "service_targets", "follow_up_tasks", "response_templates", "case_reads",
    "attachments", "case_comments", "case_status_history", "ticket_escalations", "case_assignments", "customer_cases",
    "inquiries", "case_categories",
  ]);
};
