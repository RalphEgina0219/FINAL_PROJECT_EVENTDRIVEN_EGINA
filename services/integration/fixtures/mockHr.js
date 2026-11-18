/*
 * MOCK HR FIXTURE — NOT REAL HR DATA.
 * Used only while INTEGRATION_HR_MODE=mock, until JOHNVIVZ HR exposes its API/events.
 * Every row written from this file is stored with is_mock = 1 and source 'johnvivz_hr (mock)',
 * and is shown with a "Mock HR" badge. IDs use the MOCK- prefix so they can never collide with
 * real HR employee IDs. Only the limited reference fields CRM is allowed to keep are listed
 * (no salary, bank, government ID or payroll data — master prompt §VIII).
 */
export const MOCK_SOURCE_VERSION = "mock-fixture-2026-11-11";

export const MOCK_DEPARTMENTS = [
  { department_id: "MOCK-DEP-CRM", code: "CRM", name: "CRM / Sales (mock)" },
];

export const MOCK_POSITIONS = [
  { position_id: "MOCK-POS-CRM-MGR", department_id: "MOCK-DEP-CRM", title: "CRM Manager" },
  { position_id: "MOCK-POS-CRM-TL", department_id: "MOCK-DEP-CRM", title: "CRM Team Leader" },
  { position_id: "MOCK-POS-CRM-AGT", department_id: "MOCK-DEP-CRM", title: "CRM Agent" },
];

// crm_role / team are CRM access settings proposed for the demo (CRM decides roles; HR does not).
export const MOCK_EMPLOYEES = [
  { employee_id: "MOCK-EMP-1001", full_name: "Angela Reyes", work_email: "manager@johnvivz.test", position_id: "MOCK-POS-CRM-MGR", employment_status: "active", supervisor_employee_id: null, crm_role: "crm_manager", team: null },
  { employee_id: "MOCK-EMP-1002", full_name: "Maria Santos", work_email: "maria.santos@johnvivz.test", position_id: "MOCK-POS-CRM-TL", employment_status: "active", supervisor_employee_id: "MOCK-EMP-1001", crm_role: "team_leader", team: "TEAM-01" },
  { employee_id: "MOCK-EMP-1003", full_name: "Kristine Bautista", work_email: "kristine.bautista@johnvivz.test", position_id: "MOCK-POS-CRM-AGT", employment_status: "active", supervisor_employee_id: "MOCK-EMP-1002", crm_role: "agent", team: "TEAM-01" },
];
