// Display labels and badge styles. Badges always show a text label, so color is never the only cue.

export const STATUS_LABELS = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In Progress",
  waiting_for_customer: "Waiting for Customer",
  escalated: "Escalated",
  resolved: "Resolved",
  closed: "Closed",
};

export const STATUS_HINTS = {
  open: "Submitted, waiting to be assigned to an agent",
  assigned: "An agent was assigned and will start soon",
  in_progress: "The agent (or team leader / manager) is working on it",
  waiting_for_customer: "Waiting for the customer's reply or details",
  escalated: "Raised to the Team Leader or CRM Manager",
  resolved: "Solution provided; the customer can confirm or reopen",
  closed: "Completed and archived",
};

export const STATUS_BADGES = {
  open: "bg-sky-50 text-sky-700 ring-sky-600/20",
  assigned: "bg-cyan-50 text-cyan-800 ring-cyan-600/20",
  in_progress: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  waiting_for_customer: "bg-amber-50 text-amber-800 ring-amber-600/20",
  escalated: "bg-rose-50 text-rose-700 ring-rose-600/20",
  resolved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  closed: "bg-slate-100 text-slate-700 ring-slate-500/20",
};

export const PRIORITY_LABELS = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

export const PRIORITY_BADGES = {
  low: "bg-slate-50 text-slate-600 ring-slate-500/20",
  medium: "bg-blue-50 text-blue-700 ring-blue-600/20",
  high: "bg-orange-50 text-orange-700 ring-orange-600/20",
  urgent: "bg-red-50 text-red-700 ring-red-600/20",
};

export const CASE_TYPE_LABELS = { complaint: "Complaint", service_request: "Service Request", inquiry: "Inquiry", feedback: "Feedback" };

export const ROLE_LABELS = {
  system_admin: "System Administrator (setup)",
  crm_manager: "CRM Manager",
  team_leader: "Team Leader",
  agent: "Agent",
  customer: "Customer",
};

export const ESCALATION_LEVEL_LABELS = { 0: "Agent", 1: "Team Leader", 2: "CRM Manager" };

export const EMPLOYMENT_STATUS_LABELS = { active: "Active", on_leave: "On leave", inactive: "Inactive", separated: "Separated" };

export const HISTORY_FIELD_LABELS = {
  created: "Case submitted",
  status: "Status",
  priority: "Priority",
  category: "Category",
  assignment: "Assigned agent",
  escalation: "Escalation",
};

// Converts stored values in history rows ("in_progress") into readable labels.
export const historyValueLabel = (field, value) => {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "status" || field === "created") return STATUS_LABELS[value] || value;
  if (field === "priority") return PRIORITY_LABELS[value] || value;
  return value;
};
