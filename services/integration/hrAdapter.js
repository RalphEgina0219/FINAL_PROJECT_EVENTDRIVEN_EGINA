/*
 * HR adapter. HR owns staff identity, department, position and employment status (blueprint §5).
 * CRM keeps read-only snapshots in department_references, position_references, employee_references.
 *
 * syncReferences()          mock: loads the MOCK fixture (is_mock = 1). live: pulls departments, positions and employees from HR
 *                           (paged GET calls, contract §6) for the first load; afterwards HR events keep them current. disabled: nothing.
 *                           With INTEGRATION_HR_SYNC=pull (JohnVivzHR, contract §12.1) the live sync is services/integration/hrPullSync.js.
 * lookupEmployee(id)        live: GET /employees/{id} (contract §6), used to recover an employee CRM has not heard of yet.
 * applyEmployeeStatus(...)  the single place where an HR status change is applied. In mock mode it is
 *                           called by the fixture/tests; in live mode it is called by the inbound
 *                           EmployeeStatusChanged event handler (services/integration/inboxService.js). A deactivated or separated
 *                           employee loses CRM access at once: middleware/auth.js checks the employee
 *                           status on every request, so open sessions end on their next request.
 * apply*Snapshot(...)       live only: create-or-update a reference row from an HR event or API answer. Only the whitelisted columns
 *                           are stored: no salary, bank, government ID or payroll data ever reaches the database.
 */
import { QueryTypes } from "sequelize";
import { sequelize, ACCESS_BLOCKING_STATUSES, EMPLOYMENT_STATUSES } from "../../models/index.js";
import { modeOf, SYSTEMS, logIntegration, signedRequest, refusedMessage, IntegrationDisabledError, IntegrationUnavailableError } from "./adapterBase.js";
import { config } from "../../config/index.js";
import { runHrPullSync, pullOneEmployee } from "./hrPullSync.js";
import { AppError } from "../../helpers/errors.js";
import { MOCK_DEPARTMENTS, MOCK_POSITIONS, MOCK_EMPLOYEES, MOCK_SOURCE_VERSION } from "./fixtures/mockHr.js";
import { audit } from "../auditService.js";

const MOCK_SOURCE = "johnvivz_hr (mock)";

export const hrMode = () => modeOf("hr");

export const syncReferences = async () => {
  const mode = hrMode();
  if (mode === "disabled") throw new IntegrationDisabledError("hr");
  if (mode === "live") {
    if (config.integration.hr.sync === "pull") {
      const out = await runHrPullSync({ trigger: "manual" });
      return { departments: out.departments?.created ?? 0, positions: out.positions?.created ?? 0, employees: out.employees?.created ?? 0, pull: out };
    }
    return syncLive();
  }

  const started = Date.now();
  await sequelize.transaction(async (transaction) => {
    for (const d of MOCK_DEPARTMENTS) {
      await sequelize.query(
        `INSERT INTO department_references (department_id, code, name, is_active, source, source_version, is_mock, last_synced_at)
         VALUES (:department_id, :code, :name, 1, :source, :version, 1, NOW())
         ON DUPLICATE KEY UPDATE code = VALUES(code), name = VALUES(name), source_version = VALUES(source_version), last_synced_at = NOW()`,
        { replacements: { ...d, source: MOCK_SOURCE, version: MOCK_SOURCE_VERSION }, transaction }
      );
    }
    for (const p of MOCK_POSITIONS) {
      await sequelize.query(
        `INSERT INTO position_references (position_id, department_id, title, is_active, source, source_version, is_mock, last_synced_at)
         VALUES (:position_id, :department_id, :title, 1, :source, :version, 1, NOW())
         ON DUPLICATE KEY UPDATE department_id = VALUES(department_id), title = VALUES(title), source_version = VALUES(source_version), last_synced_at = NOW()`,
        { replacements: { ...p, source: MOCK_SOURCE, version: MOCK_SOURCE_VERSION }, transaction }
      );
    }
    for (const e of MOCK_EMPLOYEES) {
      await sequelize.query(
        `INSERT INTO employee_references (employee_id, full_name, work_email, department_id, position_id, employment_status,
                                          supervisor_employee_id, source, source_version, is_mock, last_synced_at)
         VALUES (:employee_id, :full_name, :work_email, 'MOCK-DEP-CRM', :position_id, :employment_status,
                 :supervisor_employee_id, :source, :version, 1, NOW())
         ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), work_email = VALUES(work_email), position_id = VALUES(position_id),
           supervisor_employee_id = VALUES(supervisor_employee_id), source_version = VALUES(source_version), last_synced_at = NOW()`,
        { replacements: { ...e, source: MOCK_SOURCE, version: MOCK_SOURCE_VERSION }, transaction }
      );
    }
  });
  await logIntegration({
    direction: "sync", system: SYSTEMS.hr, endpoint: "fixtures/mockHr.js", success: true, mode,
    durationMs: Date.now() - started,
    message: `Loaded ${MOCK_DEPARTMENTS.length} department(s), ${MOCK_POSITIONS.length} position(s), ${MOCK_EMPLOYEES.length} employee(s) from the MOCK fixture`,
  });
  // Statuses come from the fixture only on first load; afterwards they change through applyEmployeeStatus.
  for (const e of MOCK_EMPLOYEES) {
    const [row] = await sequelize.query("SELECT employment_status FROM employee_references WHERE employee_id = :id", { type: QueryTypes.SELECT, replacements: { id: e.employee_id } });
    if (row && ACCESS_BLOCKING_STATUSES.includes(row.employment_status)) await revokeLinkedAccess(e.employee_id, row.employment_status);
  }
  return { departments: MOCK_DEPARTMENTS.length, positions: MOCK_POSITIONS.length, employees: MOCK_EMPLOYEES.length };
};

const revokeLinkedAccess = (employeeId, status, transaction) =>
  sequelize.query(
    `UPDATE crm_users SET access_revoked_at = COALESCE(access_revoked_at, NOW()), access_revoked_reason = :reason
     WHERE employee_id = :employeeId`,
    { replacements: { employeeId, reason: `HR employment status: ${status}` }, transaction }
  );

/*
 * Applies an employment status received from HR. Returns { changed, revoked, restored }.
 * `source` is 'mock' (fixture/test) or the HR event_id in live mode.
 */
export const applyEmployeeStatus = async ({ employeeId, status, source = "mock", req = null }) => {
  if (!EMPLOYMENT_STATUSES.includes(status)) throw new Error(`Unknown employment status "${status}"`);
  const mode = hrMode();
  if (mode === "disabled") throw new IntegrationDisabledError("hr");

  const result = await sequelize.transaction(async (transaction) => {
    const [emp] = await sequelize.query(
      "SELECT employee_id, employment_status, is_mock FROM employee_references WHERE employee_id = :employeeId FOR UPDATE",
      { type: QueryTypes.SELECT, replacements: { employeeId }, transaction }
    );
    if (!emp) throw new Error(`Employee ${employeeId} is not in employee_references`);
    if (mode === "mock" && !emp.is_mock) throw new Error("Mock mode can only change mock employees");
    if (emp.employment_status === status) return { changed: false, revoked: false, restored: false, before: emp.employment_status };

    await sequelize.query(
      "UPDATE employee_references SET employment_status = :status, last_synced_at = NOW() WHERE employee_id = :employeeId",
      { replacements: { status, employeeId }, transaction }
    );
    let revoked = false;
    let restored = false;
    if (ACCESS_BLOCKING_STATUSES.includes(status)) {
      await revokeLinkedAccess(employeeId, status, transaction);
      revoked = true;
    } else if (ACCESS_BLOCKING_STATUSES.includes(emp.employment_status)) {
      // HR reactivated the employee: the HR block is lifted. A CRM Manager's own deactivation (is_active = 0) stays.
      await sequelize.query(
        "UPDATE crm_users SET access_revoked_at = NULL, access_revoked_reason = NULL WHERE employee_id = :employeeId",
        { replacements: { employeeId }, transaction }
      );
      restored = true;
    }
    return { changed: true, revoked, restored, before: emp.employment_status };
  });

  if (result.changed) {
    await audit(req, "hr_employment_status_applied", {
      actor: req?.user || null,
      recordType: "employee_reference", recordId: employeeId,
      before: { employment_status: result.before }, after: { employment_status: status },
      details: `${mode} mode (source: ${source})${result.revoked ? "; CRM access revoked" : ""}${result.restored ? "; HR block lifted" : ""}`,
    });
    await logIntegration({
      direction: mode === "mock" ? "sync" : "inbound_event", system: SYSTEMS.hr, endpoint: "EmployeeStatusChanged",
      success: true, mode, message: `${employeeId}: ${result.before} -> ${status}`,
    });
  }
  return result;
};

/*
 * DepartmentUpdated / PositionUpdated (TC-06). HR owns these reference rows; CRM only stores a copy.
 * This is the single write path: mock mode calls it from the setup simulator and the tests, and the
 * live inbound handler will call it from P6. No CRM screen edits department_references or
 * position_references. Every event refreshes last_synced_at.
 */
const applyReferenceUpdate = async ({ table, idColumn, id, fields, event, source, req }) => {
  const mode = hrMode();
  if (mode === "disabled") throw new IntegrationDisabledError("hr");
  const result = await sequelize.transaction(async (transaction) => {
    const [row] = await sequelize.query(`SELECT * FROM ${table} WHERE ${idColumn} = :id FOR UPDATE`, { type: QueryTypes.SELECT, replacements: { id }, transaction });
    if (!row) throw new Error(`${event}: ${id} is not in ${table}`);
    if (mode === "mock" && !row.is_mock) throw new Error("Mock mode can only change mock references");
    const before = {};
    const after = {};
    for (const [column, value] of Object.entries(fields)) {
      if (value === undefined || value === null || row[column] === value) continue;
      before[column] = row[column];
      after[column] = value;
    }
    const sets = Object.keys(after).map((c) => `${c} = :${c}`);
    await sequelize.query(
      `UPDATE ${table} SET ${[...sets, "last_synced_at = NOW()"].join(", ")} WHERE ${idColumn} = :id`,
      { replacements: { ...after, id }, transaction }
    );
    return { changed: Object.keys(after).length > 0, before, after };
  });
  await audit(req, "hr_reference_updated", {
    actor: req?.user || null, recordType: table, recordId: id, before: result.before, after: result.after,
    details: `${event} (${mode} mode, source: ${source})`,
  });
  await logIntegration({
    direction: mode === "mock" ? "sync" : "inbound_event", system: SYSTEMS.hr, endpoint: event, success: true, mode,
    message: result.changed ? `${id}: ${Object.keys(result.after).join(", ")} updated` : `${id}: no field changed, last_synced_at refreshed`,
  });
  return result;
};

export const applyDepartmentUpdate = ({ departmentId, name, code, isActive, source = "mock", req = null }) =>
  applyReferenceUpdate({
    table: "department_references", idColumn: "department_id", id: departmentId, event: "DepartmentUpdated", source, req,
    fields: { name, code, is_active: isActive === undefined ? undefined : (isActive ? 1 : 0) },
  });

export const applyPositionUpdate = ({ positionId, title, departmentId, isActive, source = "mock", req = null }) =>
  applyReferenceUpdate({
    table: "position_references", idColumn: "position_id", id: positionId, event: "PositionUpdated", source, req,
    fields: { title, department_id: departmentId, is_active: isActive === undefined ? undefined : (isActive ? 1 : 0) },
  });

// ---------------------------------------------------------------- live mode (docs/integration-contract.md §5 and §6)

const API = "/api/integration/v1";
const EMPLOYMENT = ["active", "on_leave", "inactive", "separated"];
const text = (v, max) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max));

const hrCall = async (path, query) => {
  const res = await signedRequest("hr", { path: `${API}${path}`, query });
  if (res.status >= 500) throw new IntegrationUnavailableError("hr", `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new AppError(refusedMessage("hr"), 503);
  return res;
};

const pullAll = async (path) => {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const res = await hrCall(path, { page });
    if (!res.ok || !Array.isArray(res.json?.items)) throw new AppError(`HR answered ${res.status} for ${path}.`, 502);
    items.push(...res.json.items);
    if (page >= Number(res.json.total_pages || 1)) break;
  }
  return items;
};

const syncLive = async () => {
  const started = Date.now();
  const departments = await pullAll("/departments");
  const positions = await pullAll("/positions");
  const employees = await pullAll("/employees");
  for (const d of departments) await applyDepartmentSnapshot(d, { source: "api" });
  for (const p of positions) await applyPositionSnapshot(p, { source: "api" });
  for (const e of employees) await applyEmployeeSnapshot(e, { source: "api" });
  await logIntegration({
    direction: "sync", system: SYSTEMS.hr, endpoint: `${API}/employees`, success: true, mode: "live", durationMs: Date.now() - started,
    message: `Loaded ${departments.length} department(s), ${positions.length} position(s), ${employees.length} employee(s) from HR`,
  });
  return { departments: departments.length, positions: positions.length, employees: employees.length };
};

// GET /employees/{employee_id}; returns the answer, or null when HR does not know the employee (or the adapter is not live).
export const lookupEmployee = async (employeeId) => {
  const mode = hrMode();
  if (mode === "disabled") throw new IntegrationDisabledError("hr");
  if (mode !== "live") return null;
  if (config.integration.hr.sync === "pull") return pullOneEmployee(employeeId);
  const res = await hrCall(`/employees/${encodeURIComponent(employeeId)}`);
  if (res.status === 404) return null;
  if (!res.ok || !res.json) throw new AppError(`HR answered ${res.status} for employee ${employeeId}.`, 502);
  return res.json;
};

const refuseUnlessLive = () => {
  if (hrMode() !== "live") throw new Error("HR snapshots from events and the API are only applied in live mode.");
};

export const applyDepartmentSnapshot = async (d, { source = "api", req = null } = {}) => {
  refuseUnlessLive();
  const id = text(d.department_id, 64);
  if (!id || !text(d.name, 120)) throw new Error("A department needs department_id and name.");
  const [before] = await sequelize.query("SELECT name, code, is_active FROM department_references WHERE department_id = :id", { type: QueryTypes.SELECT, replacements: { id } });
  await sequelize.query(
    `INSERT INTO department_references (department_id, code, name, is_active, source, source_version, is_mock, last_synced_at)
     VALUES (:id, :code, :name, :active, :source, :version, 0, NOW())
     ON DUPLICATE KEY UPDATE code = VALUES(code), name = VALUES(name), is_active = VALUES(is_active), source = VALUES(source), source_version = VALUES(source_version), is_mock = 0, last_synced_at = NOW()`,
    { replacements: { id, code: text(d.code, 30), name: text(d.name, 120), active: d.is_active === false || d.status === "inactive" ? 0 : 1, source: SYSTEMS.hr, version: text(source, 40) } }
  );
  await audit(req, "hr_reference_updated", { actor: null, recordType: "department_references", recordId: id, before: before || null, after: { name: d.name, code: d.code ?? null }, details: `live mode (source: ${source})` });
};

export const applyPositionSnapshot = async (p, { source = "api", req = null } = {}) => {
  refuseUnlessLive();
  const id = text(p.position_id, 64);
  if (!id || !text(p.title, 120)) throw new Error("A position needs position_id and title.");
  const [before] = await sequelize.query("SELECT title, department_id, is_active FROM position_references WHERE position_id = :id", { type: QueryTypes.SELECT, replacements: { id } });
  await sequelize.query(
    `INSERT INTO position_references (position_id, department_id, title, is_active, source, source_version, is_mock, last_synced_at)
     VALUES (:id, :department, :title, :active, :source, :version, 0, NOW())
     ON DUPLICATE KEY UPDATE department_id = VALUES(department_id), title = VALUES(title), is_active = VALUES(is_active), source = VALUES(source), source_version = VALUES(source_version), is_mock = 0, last_synced_at = NOW()`,
    { replacements: { id, department: text(p.department_id, 64), title: text(p.title, 120), active: p.is_active === false || p.status === "inactive" ? 0 : 1, source: SYSTEMS.hr, version: text(source, 40) } }
  );
  await audit(req, "hr_reference_updated", { actor: null, recordType: "position_references", recordId: id, before: before || null, after: { title: p.title }, details: `live mode (source: ${source})` });
};

// Create or update an employee reference. The status of an EXISTING employee changes only through applyEmployeeStatus,
// so access is revoked or restored in one place and the change is audited.
export const applyEmployeeSnapshot = async (e, { source = "api", req = null } = {}) => {
  refuseUnlessLive();
  const id = text(e.employee_id, 64);
  const status = e.employment_status;
  if (!id || !text(e.full_name, 150)) throw new Error("An employee needs employee_id and full_name.");
  if (!EMPLOYMENT.includes(status)) throw new Error(`Unknown employment_status "${status}".`);
  const [existing] = await sequelize.query("SELECT full_name, work_email, department_id, position_id, supervisor_employee_id, employment_status FROM employee_references WHERE employee_id = :id", { type: QueryTypes.SELECT, replacements: { id } });
  const next = { full_name: text(e.full_name, 150), work_email: text(e.work_email, 254), department_id: text(e.department_id, 64), position_id: text(e.position_id, 64), supervisor_employee_id: text(e.supervisor_employee_id, 64) };
  await sequelize.query(
    `INSERT INTO employee_references (employee_id, full_name, work_email, department_id, position_id, employment_status, supervisor_employee_id, source, source_version, is_mock, last_synced_at)
     VALUES (:id, :name, :email, :department, :position, :status, :supervisor, :source, :version, 0, NOW())
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), work_email = VALUES(work_email), department_id = VALUES(department_id), position_id = VALUES(position_id),
       supervisor_employee_id = VALUES(supervisor_employee_id), source = VALUES(source), source_version = VALUES(source_version), is_mock = 0, last_synced_at = NOW()`,
    { replacements: { id, name: text(e.full_name, 150), email: text(e.work_email, 254), department: text(e.department_id, 64), position: text(e.position_id, 64), status, supervisor: text(e.supervisor_employee_id, 64), source: SYSTEMS.hr, version: text(source, 40) } }
  );
  if (!existing) {
    await audit(req, "hr_employee_reference_created", { actor: null, recordType: "employee_reference", recordId: id, after: { employment_status: status }, details: `live mode (source: ${source})` });
    if (ACCESS_BLOCKING_STATUSES.includes(status)) await revokeLinkedAccess(id, status);
  } else {
    const changed = Object.keys(next).filter((k) => (existing[k] ?? null) !== next[k]);
    if (changed.length) {
      await audit(req, "hr_employee_reference_updated", {
        actor: null, recordType: "employee_reference", recordId: id,
        before: Object.fromEntries(changed.map((k) => [k, existing[k] ?? null])), after: Object.fromEntries(changed.map((k) => [k, next[k]])), details: `live mode (source: ${source})`,
      });
    }
    if (existing.employment_status !== status) await applyEmployeeStatus({ employeeId: id, status, source, req });
  }
};
