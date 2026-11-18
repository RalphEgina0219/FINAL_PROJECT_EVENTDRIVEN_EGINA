/*
 * JOHNVIVZ CRM — model registry and associations (database johnvivz_crm_db).
 * Import models from here so associations are always defined. Tables without a model here
 * (sales, integration, approvals, forecasts, ...) are created by migrations and get their models
 * in the phase that builds their screens.
 */
import { sequelize } from "./db.js";
import { CrmUser, ROLES, STAFF_ROLES } from "./crmUserModel.js";
import { CrmTeam } from "./crmTeamModel.js";
import { EmployeeReference, EMPLOYMENT_STATUSES, ACCESS_BLOCKING_STATUSES } from "./employeeReferenceModel.js";
import { Customer } from "./customerModel.js";
import { CustomerAccount } from "./customerAccountModel.js";
import { CaseCategory } from "./caseCategoryModel.js";
import {
  CustomerCase, CASE_STATUSES, ACTIVE_CASE_STATUSES, CASE_PRIORITIES, CASE_TYPES, CASE_CHANNELS,
} from "./customerCaseModel.js";
import { CaseComment } from "./caseCommentModel.js";
import { Attachment } from "./attachmentModel.js";
import { CaseStatusHistory } from "./caseStatusHistoryModel.js";
import { CaseAssignment } from "./caseAssignmentModel.js";
import { TicketEscalation } from "./ticketEscalationModel.js";
import { CustomerRating } from "./customerRatingModel.js";
import { CustomerFeedback } from "./customerFeedbackModel.js";

CrmUser.belongsTo(CrmTeam, { foreignKey: "team_id", as: "team" });
CrmUser.belongsTo(EmployeeReference, { foreignKey: "employee_id", targetKey: "employee_id", as: "employee" });
CrmTeam.hasMany(CrmUser, { foreignKey: "team_id", as: "members" });
CrmTeam.belongsTo(CrmUser, { foreignKey: "team_leader_id", as: "teamLeader" });
CrmTeam.belongsTo(CrmUser, { foreignKey: "manager_id", as: "manager" });

Customer.hasOne(CustomerAccount, { foreignKey: "customer_id", as: "account" });
CustomerAccount.belongsTo(Customer, { foreignKey: "customer_id", as: "customer" });
CustomerAccount.belongsTo(CrmUser, { foreignKey: "user_id", as: "user" });

CustomerCase.belongsTo(Customer, { foreignKey: "customer_id", as: "customer" });
CustomerCase.belongsTo(CaseCategory, { foreignKey: "category_id", as: "category" });
CustomerCase.belongsTo(CrmUser, { foreignKey: "assigned_agent_id", as: "agent" });
CustomerCase.belongsTo(CrmTeam, { foreignKey: "team_id", as: "team" });
CustomerCase.hasMany(CaseComment, { foreignKey: "case_id", as: "comments" });
CustomerCase.hasMany(CaseStatusHistory, { foreignKey: "case_id", as: "history" });
CustomerCase.hasMany(CaseAssignment, { foreignKey: "case_id", as: "assignments" });
CustomerCase.hasMany(TicketEscalation, { foreignKey: "case_id", as: "escalations" });
CustomerCase.hasOne(CustomerRating, { foreignKey: "case_id", as: "rating" });
CaseComment.belongsTo(CrmUser, { foreignKey: "author_id", as: "author" });
CustomerRating.hasOne(CustomerFeedback, { foreignKey: "rating_id", as: "feedback" });

export {
  sequelize,
  CrmUser, ROLES, STAFF_ROLES, CrmTeam,
  EmployeeReference, EMPLOYMENT_STATUSES, ACCESS_BLOCKING_STATUSES,
  Customer, CustomerAccount, CaseCategory,
  CustomerCase, CASE_STATUSES, ACTIVE_CASE_STATUSES, CASE_PRIORITIES, CASE_TYPES, CASE_CHANNELS,
  CaseComment, Attachment, CaseStatusHistory, CaseAssignment, TicketEscalation, CustomerRating, CustomerFeedback,
};
