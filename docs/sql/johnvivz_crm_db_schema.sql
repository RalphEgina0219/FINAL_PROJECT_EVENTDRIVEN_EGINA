
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `agent_assignments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `agent_id` int NOT NULL,
  `assigned_by` int DEFAULT NULL,
  `assigned_at` datetime NOT NULL,
  `ended_at` datetime DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `agent_assignments_active_idx` (`agent_id`,`ended_at`),
  KEY `agent_assignments_customer_idx` (`customer_id`,`ended_at`),
  KEY `agent_assignments_by_fk` (`assigned_by`),
  CONSTRAINT `agent_assignments_agent_fk` FOREIGN KEY (`agent_id`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `agent_assignments_by_fk` FOREIGN KEY (`assigned_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `agent_assignments_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `approval_requests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `request_id` varchar(64) NOT NULL COMMENT 'HR/ESS request ID',
  `request_type` enum('leave','attendance_correction','overtime','other') NOT NULL,
  `requester_employee_id` varchar(64) NOT NULL,
  `requester_user_id` int DEFAULT NULL,
  `approver_user_id` int DEFAULT NULL COMMENT 'resolved CRM approver; NULL with status exception',
  `approver_role` varchar(30) DEFAULT NULL,
  `status` enum('pending','approved','rejected','returned','exception') NOT NULL DEFAULT 'pending',
  `exception_reason` varchar(255) DEFAULT NULL,
  `summary` varchar(255) NOT NULL,
  `payload` json NOT NULL COMMENT 'dates/hours/reason exactly as sent by HR/ESS',
  `decided_by` int DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `decision_reason` varchar(255) DEFAULT NULL,
  `source_event_id` char(36) DEFAULT NULL,
  `decision_event_id` char(36) DEFAULT NULL COMMENT 'outbox event sent back to HR',
  `is_mock` tinyint(1) NOT NULL DEFAULT '0',
  `received_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `request_id` (`request_id`),
  KEY `approval_requests_queue_idx` (`approver_user_id`,`status`),
  KEY `approval_requests_requester_fk` (`requester_user_id`),
  KEY `approval_requests_decider_fk` (`decided_by`),
  CONSTRAINT `approval_requests_approver_fk` FOREIGN KEY (`approver_user_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `approval_requests_decider_fk` FOREIGN KEY (`decided_by`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `approval_requests_requester_fk` FOREIGN KEY (`requester_user_id`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `approval_requests_no_self_chk` CHECK (((`decided_by` is null) or (`requester_user_id` is null) or (`decided_by` <> `requester_user_id`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `attachments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `entity_type` enum('case','case_comment','inquiry','customer','sales_order','refund') NOT NULL,
  `entity_id` int NOT NULL,
  `case_id` int DEFAULT NULL COMMENT 'set for case and case_comment files so access follows the case',
  `uploaded_by` int NOT NULL,
  `original_name` varchar(200) NOT NULL,
  `stored_name` varchar(80) NOT NULL,
  `mime_type` varchar(120) NOT NULL,
  `size_bytes` int NOT NULL,
  `visibility` enum('public','internal') NOT NULL DEFAULT 'public',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `stored_name` (`stored_name`),
  KEY `attachments_entity_idx` (`entity_type`,`entity_id`),
  KEY `attachments_case_idx` (`case_id`),
  KEY `attachments_user_fk` (`uploaded_by`),
  CONSTRAINT `attachments_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `attachments_user_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `crm_users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `campaigns` (
  `id` int NOT NULL AUTO_INCREMENT,
  `campaign_code` varchar(20) NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` text,
  `channel` enum('in_store','sms','email','social','portal','mixed') NOT NULL,
  `target_segment_id` int DEFAULT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `status` enum('draft','active','ended','cancelled') NOT NULL DEFAULT 'draft',
  `created_by` int DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `campaign_code` (`campaign_code`),
  KEY `campaigns_segment_fk` (`target_segment_id`),
  KEY `campaigns_user_fk` (`created_by`),
  CONSTRAINT `campaigns_segment_fk` FOREIGN KEY (`target_segment_id`) REFERENCES `customer_segments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `campaigns_user_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `campaigns_dates_chk` CHECK ((`end_date` >= `start_date`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cart_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `cart_id` int NOT NULL,
  `product_id` varchar(64) NOT NULL,
  `sku` varchar(64) NOT NULL,
  `product_name` varchar(200) NOT NULL,
  `quantity` decimal(12,3) NOT NULL,
  `unit_price_snapshot` decimal(12,2) NOT NULL COMMENT 'price shown when added; re-validated with Inventory at checkout',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cart_items_product_unique` (`cart_id`,`product_id`),
  CONSTRAINT `cart_items_cart_fk` FOREIGN KEY (`cart_id`) REFERENCES `cart_records` (`id`) ON DELETE CASCADE,
  CONSTRAINT `cart_items_qty_chk` CHECK ((`quantity` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cart_records` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `status` enum('active','checked_out','abandoned') NOT NULL DEFAULT 'active',
  `checked_out_order_id` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `cart_records_customer_idx` (`customer_id`,`status`),
  KEY `cart_records_order_fk` (`checked_out_order_id`),
  CONSTRAINT `cart_records_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `cart_records_order_fk` FOREIGN KEY (`checked_out_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `case_assignments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `case_id` int NOT NULL,
  `agent_id` int NOT NULL,
  `team_id` int DEFAULT NULL,
  `assigned_by` int DEFAULT NULL,
  `assigned_at` datetime NOT NULL,
  `unassigned_at` datetime DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `case_assignments_case_idx` (`case_id`),
  KEY `case_assignments_agent_idx` (`agent_id`),
  KEY `case_assignments_team_fk` (`team_id`),
  KEY `case_assignments_by_fk` (`assigned_by`),
  CONSTRAINT `case_assignments_agent_fk` FOREIGN KEY (`agent_id`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `case_assignments_by_fk` FOREIGN KEY (`assigned_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `case_assignments_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `case_assignments_team_fk` FOREIGN KEY (`team_id`) REFERENCES `crm_teams` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=143 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `case_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(80) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `default_priority` enum('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `case_comments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `case_id` int NOT NULL,
  `author_id` int NOT NULL,
  `visibility` enum('public','internal') NOT NULL DEFAULT 'public',
  `body` text NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `case_comments_case_idx` (`case_id`,`created_at`),
  KEY `case_comments_author_fk` (`author_id`),
  CONSTRAINT `case_comments_author_fk` FOREIGN KEY (`author_id`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `case_comments_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=309 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `case_reads` (
  `user_id` int NOT NULL,
  `case_id` int NOT NULL,
  `last_read_at` datetime NOT NULL,
  PRIMARY KEY (`user_id`,`case_id`),
  KEY `case_reads_case_fk` (`case_id`),
  CONSTRAINT `case_reads_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `case_reads_user_fk` FOREIGN KEY (`user_id`) REFERENCES `crm_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `case_status_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `case_id` int NOT NULL,
  `changed_by` int DEFAULT NULL COMMENT 'NULL = system job',
  `field` enum('created','status','priority','category','assignment','escalation') NOT NULL,
  `old_value` varchar(120) DEFAULT NULL,
  `new_value` varchar(120) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `case_status_history_case_idx` (`case_id`,`created_at`),
  KEY `case_status_history_user_fk` (`changed_by`),
  CONSTRAINT `case_status_history_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `case_status_history_user_fk` FOREIGN KEY (`changed_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=737 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_audit_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `actor_user_id` int DEFAULT NULL COMMENT 'NULL = system job or integration',
  `actor_role` varchar(30) DEFAULT NULL,
  `action` varchar(60) NOT NULL,
  `outcome` enum('success','denied','failed') NOT NULL DEFAULT 'success',
  `record_type` varchar(40) DEFAULT NULL,
  `record_id` varchar(64) DEFAULT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `details` varchar(500) DEFAULT NULL,
  `before_values` json DEFAULT NULL,
  `after_values` json DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `correlation_id` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `crm_audit_logs_created_idx` (`created_at`),
  KEY `crm_audit_logs_record_idx` (`record_type`,`record_id`),
  KEY `crm_audit_logs_actor_idx` (`actor_user_id`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=47 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `crm_audit_logs_block_update` BEFORE UPDATE ON `crm_audit_logs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_audit_logs is append-only' */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `crm_audit_logs_block_delete` BEFORE DELETE ON `crm_audit_logs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_audit_logs is append-only' */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_notifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `type` enum('new_case','assignment','new_reply','status_change','resolved','sla_overdue','escalation','feedback','order','follow_up','approval','integration','account') NOT NULL,
  `title` varchar(150) NOT NULL,
  `message` varchar(255) DEFAULT NULL,
  `link` varchar(255) DEFAULT NULL,
  `related_type` varchar(30) DEFAULT NULL,
  `related_id` int DEFAULT NULL,
  `read_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `crm_notifications_user_idx` (`user_id`,`read_at`),
  KEY `crm_notifications_related_idx` (`related_type`,`related_id`),
  CONSTRAINT `crm_notifications_user_fk` FOREIGN KEY (`user_id`) REFERENCES `crm_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=208 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_settings` (
  `setting_key` varchar(60) NOT NULL,
  `setting_value` varchar(255) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `updated_by` int DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`),
  KEY `crm_settings_user_fk` (`updated_by`),
  CONSTRAINT `crm_settings_user_fk` FOREIGN KEY (`updated_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_teams` (
  `id` int NOT NULL AUTO_INCREMENT,
  `team_code` varchar(20) NOT NULL,
  `name` varchar(100) NOT NULL,
  `team_leader_id` int DEFAULT NULL,
  `manager_id` int DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `team_code` (`team_code`),
  KEY `crm_teams_leader_fk` (`team_leader_id`),
  KEY `crm_teams_manager_fk` (`manager_id`),
  CONSTRAINT `crm_teams_leader_fk` FOREIGN KEY (`team_leader_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `crm_teams_manager_fk` FOREIGN KEY (`manager_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crm_users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_type` enum('system','staff','customer') NOT NULL,
  `role` varchar(30) NOT NULL,
  `employee_id` varchar(64) DEFAULT NULL COMMENT 'staff: HR employee_id',
  `email` varchar(254) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `display_name` varchar(150) NOT NULL,
  `team_id` int DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'CRM access switch',
  `is_available` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'agents: accepts new assignments',
  `email_verified_at` datetime DEFAULT NULL,
  `last_login_at` datetime DEFAULT NULL,
  `access_revoked_at` datetime DEFAULT NULL,
  `access_revoked_reason` varchar(255) DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `employee_id` (`employee_id`),
  KEY `crm_users_role_idx` (`role`,`is_active`),
  KEY `crm_users_team_fk` (`team_id`),
  CONSTRAINT `crm_users_employee_fk` FOREIGN KEY (`employee_id`) REFERENCES `employee_references` (`employee_id`),
  CONSTRAINT `crm_users_role_fk` FOREIGN KEY (`role`) REFERENCES `roles` (`code`),
  CONSTRAINT `crm_users_team_fk` FOREIGN KEY (`team_id`) REFERENCES `crm_teams` (`id`) ON DELETE SET NULL,
  CONSTRAINT `crm_users_type_chk` CHECK ((((`user_type` = _utf8mb4'system') and (`role` = _utf8mb4'system_admin') and (`employee_id` is null)) or ((`user_type` = _utf8mb4'staff') and (`role` in (_utf8mb4'crm_manager',_utf8mb4'team_leader',_utf8mb4'agent')) and (`employee_id` is not null)) or ((`user_type` = _utf8mb4'customer') and (`role` = _utf8mb4'customer') and (`employee_id` is null))))
) ENGINE=InnoDB AUTO_INCREMENT=36 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `user_id` int NOT NULL,
  `status` enum('pending_verification','active','suspended','closed') NOT NULL DEFAULT 'active',
  `registered_via` enum('portal','in_store','staff') NOT NULL DEFAULT 'portal',
  `terms_accepted_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `customer_id` (`customer_id`),
  UNIQUE KEY `user_id` (`user_id`),
  CONSTRAINT `customer_accounts_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `customer_accounts_user_fk` FOREIGN KEY (`user_id`) REFERENCES `crm_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_addresses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `label` varchar(40) DEFAULT NULL,
  `line1` varchar(200) NOT NULL,
  `barangay` varchar(100) DEFAULT NULL,
  `city_municipality` varchar(100) DEFAULT NULL,
  `province` varchar(100) DEFAULT NULL,
  `postal_code` varchar(10) DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `customer_addresses_customer_idx` (`customer_id`),
  CONSTRAINT `customer_addresses_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=23 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_cases` (
  `id` int NOT NULL AUTO_INCREMENT,
  `case_no` varchar(24) NOT NULL COMMENT 'JVT-YYYYMMDD-0001',
  `customer_id` int NOT NULL,
  `case_type` enum('complaint','service_request','inquiry','feedback') NOT NULL,
  `category_id` int NOT NULL,
  `subject` varchar(150) NOT NULL,
  `description` text NOT NULL,
  `priority` enum('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  `status` enum('open','assigned','in_progress','waiting_for_customer','escalated','resolved','closed') NOT NULL DEFAULT 'open',
  `escalation_level` tinyint NOT NULL DEFAULT '0' COMMENT '0 agent, 1 team leader, 2 CRM manager',
  `channel` enum('portal','phone','walk_in','sms','social','email') NOT NULL DEFAULT 'portal',
  `team_id` int DEFAULT NULL,
  `assigned_agent_id` int DEFAULT NULL,
  `sales_order_id` int DEFAULT NULL COMMENT 'linked CRM order, if any',
  `order_reference` varchar(60) DEFAULT NULL COMMENT 'receipt/order number typed by the customer',
  `inquiry_id` int DEFAULT NULL COMMENT 'set when converted from an inquiry',
  `first_response_due_at` datetime DEFAULT NULL,
  `resolution_due_at` datetime DEFAULT NULL,
  `first_response_at` datetime DEFAULT NULL,
  `resolved_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `reopen_count` int NOT NULL DEFAULT '0',
  `sla_breach_notified_at` datetime DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `case_no` (`case_no`),
  KEY `customer_cases_status_idx` (`status`),
  KEY `customer_cases_agent_idx` (`assigned_agent_id`),
  KEY `customer_cases_team_idx` (`team_id`),
  KEY `customer_cases_customer_idx` (`customer_id`),
  KEY `customer_cases_created_idx` (`created_at`),
  KEY `customer_cases_category_fk` (`category_id`),
  KEY `customer_cases_order_fk` (`sales_order_id`),
  KEY `customer_cases_inquiry_fk` (`inquiry_id`),
  KEY `customer_cases_created_by_fk` (`created_by`),
  CONSTRAINT `customer_cases_agent_fk` FOREIGN KEY (`assigned_agent_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_cases_category_fk` FOREIGN KEY (`category_id`) REFERENCES `case_categories` (`id`),
  CONSTRAINT `customer_cases_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_cases_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `customer_cases_inquiry_fk` FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_cases_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_cases_team_fk` FOREIGN KEY (`team_id`) REFERENCES `crm_teams` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_cases_level_chk` CHECK ((`escalation_level` between 0 and 2))
) ENGINE=InnoDB AUTO_INCREMENT=162 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_consents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `consent_type` enum('data_privacy','terms','marketing_sms','marketing_email') NOT NULL,
  `granted` tinyint(1) NOT NULL,
  `policy_version` varchar(20) NOT NULL,
  `channel` enum('portal','in_store','phone','paper') NOT NULL,
  `recorded_by` int DEFAULT NULL,
  `granted_at` datetime DEFAULT NULL,
  `withdrawn_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `customer_consents_idx` (`customer_id`,`consent_type`),
  KEY `customer_consents_user_fk` (`recorded_by`),
  CONSTRAINT `customer_consents_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `customer_consents_user_fk` FOREIGN KEY (`recorded_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=45 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_contacts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `contact_type` enum('mobile','landline','email','messenger','other') NOT NULL,
  `value` varchar(254) NOT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `verified_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `customer_contacts_customer_idx` (`customer_id`),
  CONSTRAINT `customer_contacts_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=37 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_feedback` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `rating_id` int DEFAULT NULL,
  `case_id` int DEFAULT NULL,
  `sales_order_id` int DEFAULT NULL,
  `feedback_type` enum('service','product','store','suggestion','compliment','other') NOT NULL DEFAULT 'service',
  `comment` text NOT NULL,
  `status` enum('new','reviewed','actioned') NOT NULL DEFAULT 'new',
  `reviewed_by` int DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `rating_id` (`rating_id`),
  KEY `customer_feedback_status_idx` (`status`,`created_at`),
  KEY `customer_feedback_customer_fk` (`customer_id`),
  KEY `customer_feedback_case_fk` (`case_id`),
  KEY `customer_feedback_order_fk` (`sales_order_id`),
  KEY `customer_feedback_reviewer_fk` (`reviewed_by`),
  CONSTRAINT `customer_feedback_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_feedback_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `customer_feedback_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_feedback_rating_fk` FOREIGN KEY (`rating_id`) REFERENCES `customer_ratings` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customer_feedback_reviewer_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=37 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_interactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `crm_user_id` int DEFAULT NULL,
  `interaction_type` enum('call','visit','sms','email','chat','portal','note') NOT NULL,
  `direction` enum('inbound','outbound','internal') NOT NULL,
  `subject` varchar(150) NOT NULL,
  `summary` text,
  `related_type` enum('case','inquiry','order','sale','follow_up','campaign') DEFAULT NULL,
  `related_id` int DEFAULT NULL,
  `occurred_at` datetime NOT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `customer_interactions_customer_idx` (`customer_id`,`occurred_at`),
  KEY `customer_interactions_user_fk` (`crm_user_id`),
  CONSTRAINT `customer_interactions_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `customer_interactions_user_fk` FOREIGN KEY (`crm_user_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_preferences` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `preference_key` varchar(60) NOT NULL COMMENT 'preferred_channel, preferred_branch, language, ...',
  `preference_value` varchar(255) NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `customer_preferences_unique` (`customer_id`,`preference_key`),
  CONSTRAINT `customer_preferences_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_ratings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `subject_type` enum('case','order') NOT NULL,
  `case_id` int DEFAULT NULL,
  `sales_order_id` int DEFAULT NULL,
  `rating` tinyint NOT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `case_id` (`case_id`),
  UNIQUE KEY `sales_order_id` (`sales_order_id`),
  KEY `customer_ratings_customer_fk` (`customer_id`),
  CONSTRAINT `customer_ratings_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`),
  CONSTRAINT `customer_ratings_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `customer_ratings_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`),
  CONSTRAINT `customer_ratings_rating_chk` CHECK ((`rating` between 1 and 5)),
  CONSTRAINT `customer_ratings_subject_chk` CHECK ((((`subject_type` = _utf8mb4'case') and (`case_id` is not null) and (`sales_order_id` is null)) or ((`subject_type` = _utf8mb4'order') and (`sales_order_id` is not null) and (`case_id` is null))))
) ENGINE=InnoDB AUTO_INCREMENT=45 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_segments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(30) NOT NULL,
  `name` varchar(60) NOT NULL,
  `rule_description` varchar(255) NOT NULL COMMENT 'rule-based segmentation (no AI/ML)',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` char(36) NOT NULL COMMENT 'shared UUID (Inventory, Accounting); never changes',
  `customer_no` varchar(20) NOT NULL COMMENT 'CUS-000001',
  `first_name` varchar(80) NOT NULL,
  `last_name` varchar(80) NOT NULL,
  `email` varchar(254) DEFAULT NULL,
  `mobile` varchar(30) DEFAULT NULL,
  `normalized_email` varchar(254) DEFAULT NULL COMMENT 'lower(trim(email)) for duplicate checks',
  `normalized_mobile` varchar(20) DEFAULT NULL COMMENT 'digits only, 09XXXXXXXXX',
  `customer_type` enum('individual','business') NOT NULL DEFAULT 'individual',
  `source` enum('walk_in','portal','phone','social','referral','other') NOT NULL DEFAULT 'walk_in',
  `segment_id` int DEFAULT NULL,
  `status` enum('active','inactive','merged') NOT NULL DEFAULT 'active',
  `merged_into_id` int DEFAULT NULL,
  `notes` text,
  `created_by` int DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `customer_id` (`customer_id`),
  UNIQUE KEY `customer_no` (`customer_no`),
  KEY `customers_email_idx` (`normalized_email`),
  KEY `customers_mobile_idx` (`normalized_mobile`),
  KEY `customers_name_idx` (`last_name`,`first_name`),
  KEY `customers_segment_fk` (`segment_id`),
  KEY `customers_merged_fk` (`merged_into_id`),
  KEY `customers_created_by_fk` (`created_by`),
  CONSTRAINT `customers_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `customers_merged_fk` FOREIGN KEY (`merged_into_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `customers_segment_fk` FOREIGN KEY (`segment_id`) REFERENCES `customer_segments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=23 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `department_references` (
  `id` int NOT NULL AUTO_INCREMENT,
  `department_id` varchar(64) NOT NULL COMMENT 'HR stable ID',
  `code` varchar(30) DEFAULT NULL,
  `name` varchar(120) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `source` varchar(40) NOT NULL DEFAULT 'johnvivz_hr',
  `source_version` varchar(40) DEFAULT NULL,
  `is_mock` tinyint(1) NOT NULL DEFAULT '0',
  `last_synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `department_id` (`department_id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `discounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `discount_code` varchar(30) NOT NULL,
  `name` varchar(120) NOT NULL,
  `discount_type` enum('senior_citizen','pwd','loyalty','manual') NOT NULL,
  `percent` decimal(5,2) DEFAULT NULL,
  `amount` decimal(12,2) DEFAULT NULL,
  `requires_approval` tinyint(1) NOT NULL DEFAULT '0',
  `requires_id_reference` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'SC/PWD ID number captured on the order',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `discount_code` (`discount_code`),
  CONSTRAINT `discounts_value_chk` CHECK (((`percent` is not null) <> (`amount` is not null)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `email_verification_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 of the token; the raw token is never stored',
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `token_hash` (`token_hash`),
  KEY `email_tokens_user_fk` (`user_id`),
  CONSTRAINT `email_tokens_user_fk` FOREIGN KEY (`user_id`) REFERENCES `crm_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `employee_references` (
  `id` int NOT NULL AUTO_INCREMENT,
  `employee_id` varchar(64) NOT NULL COMMENT 'HR stable ID',
  `full_name` varchar(150) NOT NULL,
  `work_email` varchar(254) DEFAULT NULL,
  `department_id` varchar(64) DEFAULT NULL,
  `position_id` varchar(64) DEFAULT NULL,
  `employment_status` enum('active','on_leave','inactive','separated') NOT NULL,
  `supervisor_employee_id` varchar(64) DEFAULT NULL COMMENT 'immediate supervisor, used for ESS approval routing',
  `source` varchar(40) NOT NULL DEFAULT 'johnvivz_hr',
  `source_version` varchar(40) DEFAULT NULL,
  `is_mock` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 = record from the mock HR fixture, never real HR data',
  `last_synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `employee_id` (`employee_id`),
  KEY `employee_references_status_idx` (`employment_status`)
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `follow_up_tasks` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `case_id` int DEFAULT NULL,
  `sales_order_id` int DEFAULT NULL,
  `assigned_to` int NOT NULL,
  `created_by` int DEFAULT NULL,
  `title` varchar(150) NOT NULL,
  `notes` text,
  `due_at` datetime NOT NULL,
  `priority` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `status` enum('pending','done','cancelled') NOT NULL DEFAULT 'pending',
  `completed_at` datetime DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `follow_up_tasks_assignee_idx` (`assigned_to`,`status`,`due_at`),
  KEY `follow_up_tasks_customer_fk` (`customer_id`),
  KEY `follow_up_tasks_case_fk` (`case_id`),
  KEY `follow_up_tasks_order_fk` (`sales_order_id`),
  KEY `follow_up_tasks_created_by_fk` (`created_by`),
  CONSTRAINT `follow_up_tasks_assignee_fk` FOREIGN KEY (`assigned_to`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `follow_up_tasks_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE SET NULL,
  CONSTRAINT `follow_up_tasks_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `follow_up_tasks_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `follow_up_tasks_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `forecast_runs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `metric` enum('daily_sales_amount','daily_order_count','daily_case_count','product_demand') NOT NULL,
  `subject_key` varchar(64) DEFAULT NULL COMMENT 'product_id or category for product_demand',
  `method` varchar(60) NOT NULL COMMENT 'moving_average_7, linear_trend, seasonal_naive_7',
  `method_version` varchar(20) NOT NULL,
  `input_from` date NOT NULL,
  `input_to` date NOT NULL,
  `horizon_days` int NOT NULL,
  `error_metric` varchar(20) NOT NULL COMMENT 'MAPE or MAE',
  `error_value` decimal(12,4) DEFAULT NULL,
  `excluded_note` varchar(255) NOT NULL COMMENT 'what was excluded: cancelled, voided, demo, duplicates',
  `generated_by` int DEFAULT NULL,
  `generated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `forecast_runs_user_fk` (`generated_by`),
  CONSTRAINT `forecast_runs_user_fk` FOREIGN KEY (`generated_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `forecast_runs_period_chk` CHECK (((`input_to` >= `input_from`) and (`horizon_days` > 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `forecast_values` (
  `forecast_run_id` int NOT NULL,
  `period_date` date NOT NULL,
  `estimate` decimal(14,2) NOT NULL,
  `lower_bound` decimal(14,2) DEFAULT NULL,
  `upper_bound` decimal(14,2) DEFAULT NULL,
  PRIMARY KEY (`forecast_run_id`,`period_date`),
  CONSTRAINT `forecast_values_run_fk` FOREIGN KEY (`forecast_run_id`) REFERENCES `forecast_runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inquiries` (
  `id` int NOT NULL AUTO_INCREMENT,
  `inquiry_no` varchar(24) NOT NULL COMMENT 'INQ-YYYYMMDD-0001',
  `customer_id` int NOT NULL,
  `channel` enum('portal','phone','walk_in','sms','social','email') NOT NULL,
  `subject` varchar(150) NOT NULL,
  `question` text NOT NULL,
  `answer` text,
  `status` enum('open','answered','converted','closed') NOT NULL DEFAULT 'open',
  `handled_by` int DEFAULT NULL,
  `converted_case_id` int DEFAULT NULL,
  `answered_at` datetime DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `inquiry_no` (`inquiry_no`),
  KEY `inquiries_status_idx` (`status`,`created_at`),
  KEY `inquiries_customer_fk` (`customer_id`),
  KEY `inquiries_handler_fk` (`handled_by`),
  KEY `inquiries_created_by_fk` (`created_by`),
  KEY `inquiries_case_fk` (`converted_case_id`),
  CONSTRAINT `inquiries_case_fk` FOREIGN KEY (`converted_case_id`) REFERENCES `customer_cases` (`id`) ON DELETE SET NULL,
  CONSTRAINT `inquiries_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `inquiries_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `inquiries_handler_fk` FOREIGN KEY (`handled_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `integration_inbox` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` char(36) NOT NULL COMMENT 'duplicates are rejected here',
  `event_type` varchar(60) NOT NULL,
  `schema_version` int NOT NULL,
  `source` varchar(40) NOT NULL,
  `occurred_at` datetime(3) NOT NULL,
  `entity_id` varchar(64) NOT NULL,
  `correlation_id` char(36) DEFAULT NULL,
  `idempotency_key` varchar(160) NOT NULL,
  `payload` json NOT NULL,
  `status` enum('received','processed','failed','dead','ignored') NOT NULL DEFAULT 'received',
  `attempts` int NOT NULL DEFAULT '0',
  `last_error` varchar(500) DEFAULT NULL,
  `is_mock` tinyint(1) NOT NULL DEFAULT '0',
  `received_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `event_id` (`event_id`),
  UNIQUE KEY `integration_inbox_idem_unique` (`source`,`idempotency_key`),
  KEY `integration_inbox_status_idx` (`status`,`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `integration_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `direction` enum('outbound_event','inbound_event','api_call','api_served','sync') NOT NULL,
  `system` varchar(40) NOT NULL COMMENT 'johnvivz_inventory, johnvivz_hr, johnvivz_accounting',
  `endpoint` varchar(255) DEFAULT NULL,
  `http_method` varchar(10) DEFAULT NULL,
  `event_id` char(36) DEFAULT NULL,
  `correlation_id` char(36) DEFAULT NULL,
  `http_status` smallint DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `success` tinyint(1) NOT NULL,
  `mode` enum('disabled','mock','live') NOT NULL,
  `message` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `integration_logs_created_idx` (`created_at`),
  KEY `integration_logs_corr_idx` (`correlation_id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `integration_outbox` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_id` char(36) NOT NULL,
  `event_type` varchar(60) NOT NULL,
  `schema_version` int NOT NULL DEFAULT '1',
  `source` varchar(40) NOT NULL DEFAULT 'johnvivz_crm',
  `target` varchar(40) NOT NULL COMMENT 'johnvivz_inventory | johnvivz_accounting | johnvivz_hr',
  `occurred_at` datetime(3) NOT NULL,
  `entity_id` varchar(64) NOT NULL,
  `correlation_id` char(36) NOT NULL,
  `idempotency_key` varchar(160) NOT NULL,
  `payload` json NOT NULL COMMENT 'full envelope as sent',
  `status` enum('pending','sent','failed','dead','skipped_disabled','mock_delivered') NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT '0',
  `next_attempt_at` datetime DEFAULT NULL,
  `last_error` varchar(500) DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `is_mock` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `event_id` (`event_id`),
  UNIQUE KEY `integration_outbox_idem_unique` (`target`,`idempotency_key`),
  KEY `integration_outbox_dispatch_idx` (`status`,`next_attempt_at`),
  KEY `integration_outbox_corr_idx` (`correlation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `loyalty_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `points_balance` int NOT NULL DEFAULT '0',
  `tier` varchar(20) DEFAULT NULL,
  `status` enum('active','suspended','closed') NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `customer_id` (`customer_id`),
  CONSTRAINT `loyalty_accounts_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `loyalty_accounts_balance_chk` CHECK ((`points_balance` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `loyalty_transactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `loyalty_account_id` int NOT NULL,
  `sales_transaction_id` int DEFAULT NULL,
  `refund_id` int DEFAULT NULL,
  `txn_type` enum('earn','redeem','adjust','expire','reverse') NOT NULL,
  `points` int NOT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `loyalty_transactions_sale_unique` (`loyalty_account_id`,`sales_transaction_id`,`txn_type`),
  KEY `loyalty_transactions_sale_fk` (`sales_transaction_id`),
  KEY `loyalty_transactions_refund_fk` (`refund_id`),
  KEY `loyalty_transactions_user_fk` (`created_by`),
  CONSTRAINT `loyalty_transactions_account_fk` FOREIGN KEY (`loyalty_account_id`) REFERENCES `loyalty_accounts` (`id`),
  CONSTRAINT `loyalty_transactions_refund_fk` FOREIGN KEY (`refund_id`) REFERENCES `refunds` (`id`),
  CONSTRAINT `loyalty_transactions_sale_fk` FOREIGN KEY (`sales_transaction_id`) REFERENCES `sales_transactions` (`id`),
  CONSTRAINT `loyalty_transactions_user_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mail_outbox` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `to_email` varchar(254) NOT NULL,
  `subject` varchar(200) NOT NULL,
  `body_text` text NOT NULL,
  `template` varchar(40) NOT NULL COMMENT 'verify_email, reset_password, staff_invite',
  `transport` enum('log','smtp') NOT NULL,
  `status` enum('logged','sent','failed') NOT NULL,
  `error` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `mail_outbox_created_idx` (`created_at`),
  KEY `mail_outbox_to_idx` (`to_email`,`created_at`),
  KEY `mail_outbox_user_fk` (`user_id`),
  CONSTRAINT `mail_outbox_user_fk` FOREIGN KEY (`user_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `migrations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `batch` int NOT NULL,
  `run_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=14 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `number_sequences` (
  `scope` varchar(20) NOT NULL,
  `period` varchar(8) NOT NULL,
  `last_no` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`scope`,`period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_reset_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `purpose` enum('reset','invite') NOT NULL DEFAULT 'reset',
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 of the token; the raw token is never stored',
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `password_reset_tokens_hash_uq` (`token_hash`),
  KEY `password_reset_tokens_user_idx` (`user_id`,`used_at`),
  CONSTRAINT `password_reset_tokens_user_fk` FOREIGN KEY (`user_id`) REFERENCES `crm_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payment_references` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sales_order_id` int NOT NULL,
  `method` enum('cash','gcash','maya','card','bank_transfer','cod','other') NOT NULL,
  `reference_no` varchar(80) DEFAULT NULL COMMENT 'OR number / e-wallet reference',
  `amount` decimal(12,2) NOT NULL,
  `paid_at` datetime NOT NULL,
  `status` enum('recorded','verified','voided') NOT NULL DEFAULT 'recorded',
  `recorded_by` int DEFAULT NULL,
  `void_reason` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `payment_references_order_idx` (`sales_order_id`),
  KEY `payment_references_user_fk` (`recorded_by`),
  CONSTRAINT `payment_references_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`),
  CONSTRAINT `payment_references_user_fk` FOREIGN KEY (`recorded_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `payment_references_amount_chk` CHECK ((`amount` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `permissions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(60) NOT NULL,
  `module` varchar(30) NOT NULL,
  `description` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB AUTO_INCREMENT=38 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `position_references` (
  `id` int NOT NULL AUTO_INCREMENT,
  `position_id` varchar(64) NOT NULL COMMENT 'HR stable ID',
  `department_id` varchar(64) DEFAULT NULL,
  `title` varchar(120) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `source` varchar(40) NOT NULL DEFAULT 'johnvivz_hr',
  `source_version` varchar(40) DEFAULT NULL,
  `is_mock` tinyint(1) NOT NULL DEFAULT '0',
  `last_synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `position_id` (`position_id`),
  KEY `position_references_department_idx` (`department_id`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_references` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_id` varchar(64) NOT NULL COMMENT 'Inventory stable ID',
  `sku` varchar(64) NOT NULL,
  `barcode` varchar(64) DEFAULT NULL,
  `name` varchar(200) NOT NULL,
  `description` text,
  `category_name` varchar(120) DEFAULT NULL,
  `unit` varchar(30) DEFAULT NULL,
  `image_url` varchar(500) DEFAULT NULL,
  `selling_price` decimal(12,2) NOT NULL COMMENT 'owned by Inventory; CRM never edits it',
  `is_vatable` tinyint(1) NOT NULL DEFAULT '1',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `available_qty` decimal(12,3) DEFAULT NULL COMMENT 'last availability answer from Inventory',
  `availability_checked_at` datetime DEFAULT NULL,
  `low_stock` tinyint(1) NOT NULL DEFAULT '0',
  `source` varchar(40) NOT NULL DEFAULT 'johnvivz_inventory',
  `source_version` varchar(40) DEFAULT NULL,
  `is_mock` tinyint(1) NOT NULL DEFAULT '0',
  `last_synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `product_id` (`product_id`),
  UNIQUE KEY `sku` (`sku`),
  KEY `product_references_name_idx` (`name`),
  KEY `product_references_category_idx` (`category_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `promotion_redemptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `promotion_id` int NOT NULL,
  `sales_order_id` int NOT NULL,
  `customer_id` int NOT NULL,
  `discount_amount` decimal(12,2) NOT NULL,
  `redeemed_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `promotion_redemptions_unique` (`promotion_id`,`sales_order_id`),
  KEY `promotion_redemptions_order_fk` (`sales_order_id`),
  KEY `promotion_redemptions_customer_fk` (`customer_id`),
  CONSTRAINT `promotion_redemptions_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `promotion_redemptions_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `promotion_redemptions_promo_fk` FOREIGN KEY (`promotion_id`) REFERENCES `promotions` (`id`),
  CONSTRAINT `promotion_redemptions_amount_chk` CHECK ((`discount_amount` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `promotions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `promo_code` varchar(30) NOT NULL,
  `campaign_id` int DEFAULT NULL,
  `name` varchar(120) NOT NULL,
  `promo_type` enum('percent','fixed_amount') NOT NULL,
  `value` decimal(12,2) NOT NULL,
  `min_order_amount` decimal(12,2) DEFAULT NULL,
  `applies_to` enum('order','product','category') NOT NULL DEFAULT 'order',
  `product_id` varchar(64) DEFAULT NULL,
  `category_name` varchar(120) DEFAULT NULL,
  `start_at` datetime NOT NULL,
  `end_at` datetime NOT NULL,
  `usage_limit` int DEFAULT NULL,
  `status` enum('draft','pending_approval','active','expired','cancelled') NOT NULL DEFAULT 'draft',
  `created_by` int DEFAULT NULL,
  `approved_by` int DEFAULT NULL COMMENT 'must differ from created_by',
  `approved_at` datetime DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `promo_code` (`promo_code`),
  KEY `promotions_campaign_fk` (`campaign_id`),
  KEY `promotions_created_by_fk` (`created_by`),
  KEY `promotions_approved_by_fk` (`approved_by`),
  CONSTRAINT `promotions_approved_by_fk` FOREIGN KEY (`approved_by`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `promotions_campaign_fk` FOREIGN KEY (`campaign_id`) REFERENCES `campaigns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `promotions_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `promotions_dates_chk` CHECK ((`end_at` > `start_at`)),
  CONSTRAINT `promotions_self_approval_chk` CHECK (((`approved_by` is null) or (`approved_by` <> `created_by`))),
  CONSTRAINT `promotions_value_chk` CHECK ((`value` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `refunds` (
  `id` int NOT NULL AUTO_INCREMENT,
  `refund_id` char(36) NOT NULL,
  `refund_no` varchar(24) NOT NULL COMMENT 'RFD-YYYYMMDD-0001',
  `sales_transaction_id` int NOT NULL,
  `case_id` int DEFAULT NULL COMMENT 'complaint that led to the refund',
  `amount` decimal(12,2) NOT NULL,
  `reason` varchar(255) NOT NULL,
  `return_items` json DEFAULT NULL COMMENT '[{product_id, quantity, condition}] for Inventory',
  `status` enum('requested','approved','rejected','recorded') NOT NULL DEFAULT 'requested',
  `requested_by` int NOT NULL,
  `approved_by` int DEFAULT NULL,
  `approved_at` datetime DEFAULT NULL,
  `decision_reason` varchar(255) DEFAULT NULL,
  `recorded_at` datetime DEFAULT NULL,
  `correlation_id` char(36) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `refund_id` (`refund_id`),
  UNIQUE KEY `refund_no` (`refund_no`),
  KEY `refunds_sale_fk` (`sales_transaction_id`),
  KEY `refunds_requested_by_fk` (`requested_by`),
  KEY `refunds_approved_by_fk` (`approved_by`),
  KEY `refunds_case_fk` (`case_id`),
  CONSTRAINT `refunds_approved_by_fk` FOREIGN KEY (`approved_by`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `refunds_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE SET NULL,
  CONSTRAINT `refunds_requested_by_fk` FOREIGN KEY (`requested_by`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `refunds_sale_fk` FOREIGN KEY (`sales_transaction_id`) REFERENCES `sales_transactions` (`id`),
  CONSTRAINT `refunds_amount_chk` CHECK ((`amount` > 0)),
  CONSTRAINT `refunds_self_approval_chk` CHECK (((`approved_by` is null) or (`approved_by` <> `requested_by`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `response_templates` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(100) NOT NULL,
  `category_id` int DEFAULT NULL,
  `body` text NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `response_templates_category_fk` (`category_id`),
  KEY `response_templates_user_fk` (`created_by`),
  CONSTRAINT `response_templates_category_fk` FOREIGN KEY (`category_id`) REFERENCES `case_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `response_templates_user_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `role_permissions` (
  `role_id` int NOT NULL,
  `permission_id` int NOT NULL,
  PRIMARY KEY (`role_id`,`permission_id`),
  KEY `role_permissions_permission_fk` (`permission_id`),
  CONSTRAINT `role_permissions_permission_fk` FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `role_permissions_role_fk` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `roles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(30) NOT NULL,
  `name` varchar(60) NOT NULL,
  `user_type` enum('system','staff','customer') NOT NULL,
  `hierarchy_level` tinyint DEFAULT NULL COMMENT '1 CRM Manager, 2 Team Leader, 3 Agent; NULL outside the CRM hierarchy',
  `description` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_order_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sales_order_id` int NOT NULL,
  `line_no` smallint NOT NULL,
  `product_id` varchar(64) NOT NULL COMMENT 'Inventory product_id',
  `sku` varchar(64) NOT NULL,
  `product_name` varchar(200) NOT NULL COMMENT 'snapshot at order time',
  `unit` varchar(30) DEFAULT NULL,
  `quantity` decimal(12,3) NOT NULL,
  `unit_price` decimal(12,2) NOT NULL COMMENT 'Inventory price snapshot; not editable in CRM',
  `is_vatable` tinyint(1) NOT NULL DEFAULT '1',
  `promotion_id` int DEFAULT NULL,
  `discount_id` int DEFAULT NULL,
  `discount_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `line_total` decimal(12,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sales_order_items_line_unique` (`sales_order_id`,`line_no`),
  KEY `sales_order_items_promo_fk` (`promotion_id`),
  KEY `sales_order_items_discount_fk` (`discount_id`),
  CONSTRAINT `sales_order_items_discount_fk` FOREIGN KEY (`discount_id`) REFERENCES `discounts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sales_order_items_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sales_order_items_promo_fk` FOREIGN KEY (`promotion_id`) REFERENCES `promotions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sales_order_items_price_chk` CHECK (((`unit_price` >= 0) and (`discount_amount` >= 0) and (`line_total` >= 0))),
  CONSTRAINT `sales_order_items_qty_chk` CHECK ((`quantity` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `order_id` char(36) NOT NULL COMMENT 'shared UUID',
  `order_no` varchar(24) NOT NULL COMMENT 'SO-YYYYMMDD-0001',
  `customer_id` int NOT NULL,
  `agent_id` int DEFAULT NULL,
  `team_id` int DEFAULT NULL,
  `channel` enum('walk_in','phone','portal','delivery') NOT NULL,
  `fulfillment` enum('in_store','pickup','delivery') NOT NULL DEFAULT 'in_store',
  `delivery_address_id` int DEFAULT NULL,
  `status` enum('draft','submitted','pending_stock','confirmed','ready','completed','cancelled') NOT NULL DEFAULT 'draft',
  `payment_status` enum('unpaid','partially_paid','paid','partially_refunded','refunded') NOT NULL DEFAULT 'unpaid',
  `reservation_status` enum('none','requested','reserved','partially_reserved','failed','released','issued') NOT NULL DEFAULT 'none',
  `inventory_reservation_ref` varchar(64) DEFAULT NULL,
  `subtotal` decimal(12,2) NOT NULL DEFAULT '0.00',
  `discount_total` decimal(12,2) NOT NULL DEFAULT '0.00',
  `tax_total` decimal(12,2) DEFAULT NULL COMMENT 'VAT as computed by Accounting, if returned',
  `grand_total` decimal(12,2) NOT NULL DEFAULT '0.00',
  `currency` char(3) NOT NULL DEFAULT 'PHP',
  `correlation_id` char(36) NOT NULL COMMENT 'traces the order through Inventory and Accounting',
  `submitted_at` datetime DEFAULT NULL,
  `confirmed_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `cancelled_at` datetime DEFAULT NULL,
  `cancel_reason` varchar(255) DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_id` (`order_id`),
  UNIQUE KEY `order_no` (`order_no`),
  KEY `sales_orders_status_idx` (`status`,`created_at`),
  KEY `sales_orders_customer_idx` (`customer_id`),
  KEY `sales_orders_agent_idx` (`agent_id`),
  KEY `sales_orders_team_fk` (`team_id`),
  KEY `sales_orders_address_fk` (`delivery_address_id`),
  KEY `sales_orders_created_by_fk` (`created_by`),
  CONSTRAINT `sales_orders_address_fk` FOREIGN KEY (`delivery_address_id`) REFERENCES `customer_addresses` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sales_orders_agent_fk` FOREIGN KEY (`agent_id`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sales_orders_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sales_orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `sales_orders_team_fk` FOREIGN KEY (`team_id`) REFERENCES `crm_teams` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sales_orders_totals_chk` CHECK (((`subtotal` >= 0) and (`discount_total` >= 0) and (`grand_total` >= 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sales_transactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sale_id` char(36) NOT NULL COMMENT 'shared UUID in SaleCompleted',
  `transaction_no` varchar(24) NOT NULL COMMENT 'SALE-YYYYMMDD-0001',
  `sales_order_id` int NOT NULL COMMENT 'one completed sale per order',
  `customer_id` int NOT NULL,
  `gross_amount` decimal(12,2) NOT NULL,
  `discount_total` decimal(12,2) NOT NULL,
  `tax_total` decimal(12,2) DEFAULT NULL COMMENT 'VAT as computed by Accounting, if returned',
  `net_amount` decimal(12,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'PHP',
  `payment_status` enum('paid','partially_refunded','refunded') NOT NULL DEFAULT 'paid',
  `status` enum('completed','partially_refunded','refunded','cancelled','voided') NOT NULL DEFAULT 'completed',
  `completed_at` datetime NOT NULL,
  `correlation_id` char(36) NOT NULL,
  `idempotency_key` varchar(120) NOT NULL COMMENT 'SaleCompleted:<sale_id>',
  `is_demo` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `sale_id` (`sale_id`),
  UNIQUE KEY `transaction_no` (`transaction_no`),
  UNIQUE KEY `sales_order_id` (`sales_order_id`),
  UNIQUE KEY `idempotency_key` (`idempotency_key`),
  KEY `sales_transactions_completed_idx` (`completed_at`),
  KEY `sales_transactions_customer_fk` (`customer_id`),
  CONSTRAINT `sales_transactions_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`),
  CONSTRAINT `sales_transactions_order_fk` FOREIGN KEY (`sales_order_id`) REFERENCES `sales_orders` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `service_targets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `priority` enum('low','medium','high','urgent') NOT NULL,
  `team_id` int DEFAULT NULL COMMENT 'NULL = default for every team',
  `first_response_minutes` int NOT NULL,
  `resolution_minutes` int NOT NULL,
  `effective_from` datetime NOT NULL,
  `updated_by` int DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `service_targets_unique` (`priority`,`team_id`,`effective_from`),
  KEY `service_targets_team_fk` (`team_id`),
  KEY `service_targets_user_fk` (`updated_by`),
  CONSTRAINT `service_targets_team_fk` FOREIGN KEY (`team_id`) REFERENCES `crm_teams` (`id`) ON DELETE CASCADE,
  CONSTRAINT `service_targets_user_fk` FOREIGN KEY (`updated_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `service_targets_order_chk` CHECK (((`first_response_minutes` > 0) and (`resolution_minutes` >= `first_response_minutes`)))
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ticket_escalations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `case_id` int NOT NULL,
  `from_level` tinyint NOT NULL,
  `to_level` tinyint NOT NULL,
  `escalated_by` int NOT NULL,
  `escalated_to` int DEFAULT NULL COMMENT 'team leader / CRM manager who receives it',
  `reason` varchar(255) NOT NULL,
  `outcome` enum('pending','handled','returned','escalated') NOT NULL DEFAULT 'pending',
  `handled_by` int DEFAULT NULL,
  `handled_at` datetime DEFAULT NULL,
  `handling_note` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ticket_escalations_case_idx` (`case_id`),
  KEY `ticket_escalations_target_idx` (`escalated_to`,`outcome`),
  KEY `ticket_escalations_by_fk` (`escalated_by`),
  KEY `ticket_escalations_handler_fk` (`handled_by`),
  CONSTRAINT `ticket_escalations_by_fk` FOREIGN KEY (`escalated_by`) REFERENCES `crm_users` (`id`),
  CONSTRAINT `ticket_escalations_case_fk` FOREIGN KEY (`case_id`) REFERENCES `customer_cases` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ticket_escalations_handler_fk` FOREIGN KEY (`handled_by`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ticket_escalations_to_fk` FOREIGN KEY (`escalated_to`) REFERENCES `crm_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ticket_escalations_level_chk` CHECK (((`to_level` = (`from_level` + 1)) and (`to_level` between 1 and 2)))
) ENGINE=InnoDB AUTO_INCREMENT=41 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

