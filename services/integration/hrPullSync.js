/*
 * HR pull sync (interim dialect, docs/integration-contract.md §12.1). JohnVivzHR offers a read-only API (GET /employees, /departments)
 * and sends no events, so CRM reads it every 5 minutes (jobs/scheduler.js) and when the CRM Manager presses "Sync now" (Integration Health).
 * On only while INTEGRATION_HR_MODE=live AND INTEGRATION_HR_SYNC=pull.
 *
 * Each run compares what HR answers with CRM's snapshot and turns every DIFFERENCE into the event HR would have sent
 * (DepartmentCreated / DepartmentUpdated / PositionCreated / PositionUpdated / EmployeeCreated / EmployeeUpdated / EmployeeStatusChanged).
 * Those events go through the normal inbox (services/integration/inboxService.js receiveEvent), so they are applied by the SAME code as
 * real HR events: access is revoked or restored by applyEmployeeStatus, pending approvals are re-checked, and every change is audited with
 * source "hr-sync". Nothing is written when nothing changed.
 *
 * Field mapping (JohnVivzHR -> CRM):
 *   HR employee ID     permanent_employee_id when present, otherwise employee_id
 *   email              work_email
 *   status             Active -> active, On Leave -> on_leave, Resigned / Terminated -> separated,
 *                      Onboarding / Rejected -> not imported (an employee CRM already has is set to inactive, so no access stays open)
 *   position (text)    a position_references row per department + title (HR has no position_id); the employee links to it
 *   reporting_supervisor_id   supervisor_employee_id (translated to the supervisor's HR employee ID)
 * Only these fields are kept. Phone number, hire date, employment type and anything personal or about pay are never stored.
 */
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../models/index.js";
import { config } from "../../config/index.js";
import { AppError } from "../../helpers/errors.js";
import { modeOf, SYSTEMS, API, logIntegration, signedRequest, refusedMessage, IntegrationUnavailableError } from "./adapterBase.js";
import { isoWithOffset } from "./signing.js";

export const HR_SYNC_ORIGIN = "hr-sync";
export const HR_PULL_INTERVAL_MINUTES = 5;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

export const hrPullEnabled = () => modeOf("hr") === "live" && config.integration.hr.sync === "pull";

const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const text = (v, max) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));

export const STATUS_MAP = { active: "active", "on leave": "on_leave", on_leave: "on_leave", resigned: "separated", terminated: "separated" };
export const NOT_IMPORTED = ["onboarding", "rejected"];

// ---------------------------------------------------------------- reading HR

const hrGet = async (path, query) => {
  const res = await signedRequest("hr", { path: `${API}${path}`, query, direction: "sync" });
  if (res.status >= 500) throw new IntegrationUnavailableError("hr", `HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) throw new AppError(refusedMessage("hr", path), 503);
  return res;
};

// JohnVivzHR answers {success, data}. data is a list, or {items, page, page_size, total, total_pages}.
const unwrap = (res, what) => {
  if (!res.ok || !res.json || res.json.success === false) throw new AppError(`HR answered ${res.status} for ${what}${res.json?.message ? `: ${String(res.json.message).slice(0, 120)}` : ""}.`, 502);
  return res.json.data ?? res.json;
};
const listOf = (data) => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.departments) ? data.departments : Array.isArray(data?.employees) ? data.employees : null);

const fetchEmployees = async () => {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = unwrap(await hrGet("/employees", { page, page_size: PAGE_SIZE }), "/employees");
    const list = listOf(data);
    if (!list) throw new AppError("HR's /employees answer has no list of employees (expected data.items).", 502);
    items.push(...list);
    const total = Number(data.total_pages || 1);
    if (page >= total || !list.length) break;
  }
  return items;
};

const fetchDepartments = async () => {
  const list = listOf(unwrap(await hrGet("/departments"), "/departments"));
  if (!list) throw new AppError("HR's /departments answer has no list of departments.", 502);
  return list;
};

// ---------------------------------------------------------------- mapping (only whitelisted fields leave this file)

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// HR has no position_id: one stable id per department + title.
export const positionIdFor = (departmentId, title) => `HR-POS-${sha(`${departmentId || ""}|${String(title).trim().toLowerCase()}`).slice(0, 16).toUpperCase()}`;

const mapDepartment = (d) => {
  const id = text(d.department_id ?? d.id, 64);
  const name = text(d.department_name ?? d.name, 120);
  if (!id || !name) return null;
  const inactive = d.is_active === false || d.is_active === 0 || /^(inactive|archived|disabled)$/i.test(String(d.status || ""));
  return { department_id: id, name, code: text(d.department_code ?? d.code, 30), is_active: !inactive };
};

const positionTitles = (d) => (Array.isArray(d.positions) ? d.positions : [])
  .map((p) => (typeof p === "string" ? p : p?.position_title ?? p?.title ?? p?.position_name ?? p?.name))
  .map((t) => text(t, 120)).filter(Boolean);

export const hrIdOf = (e) => text(e.permanent_employee_id, 64) || text(e.employee_id, 64);

/*
 * Turns HR's answers into CRM snapshots. Returns { departments, positions, employees, skipped }.
 * employees[i] = { employee_id, legacy_id, full_name, work_email, department_id, position_id, employment_status | null, hr_status }
 */
export const mapHrData = ({ departments: rawDepartments, employees: rawEmployees }) => {
  const departments = new Map();
  const positions = new Map();
  const addPosition = (departmentId, title) => {
    const t = text(title, 120);
    if (!t) return null;
    const id = positionIdFor(departmentId, t);
    if (!positions.has(id)) positions.set(id, { position_id: id, title: t, department_id: departmentId || null });
    return id;
  };
  for (const raw of rawDepartments) {
    const d = mapDepartment(raw);
    if (!d) continue;
    departments.set(d.department_id, d);
    for (const t of positionTitles(raw)) addPosition(d.department_id, t);
  }
  // supervisor ids may be HR's numeric employee_id, the permanent id or the code: translate all of them to the HR employee ID CRM uses
  const idIndex = new Map();
  for (const e of rawEmployees) {
    const id = hrIdOf(e);
    if (!id) continue;
    for (const alias of [e.employee_id, e.permanent_employee_id, e.employee_code]) if (text(alias, 64)) idIndex.set(String(alias).trim(), id);
  }
  const employees = [];
  const skipped = { no_id: 0, unknown_status: [] };
  for (const e of rawEmployees) {
    const id = hrIdOf(e);
    const fullName = text(e.full_name, 150) || text([e.first_name, e.last_name].filter(Boolean).join(" "), 150);
    if (!id || !fullName) { skipped.no_id += 1; continue; }
    const hrStatus = String(e.status ?? e.employment_status ?? "").trim();
    const key = hrStatus.toLowerCase();
    const status = STATUS_MAP[key] || null;
    if (!status && !NOT_IMPORTED.includes(key)) { skipped.unknown_status.push(`${id} (${hrStatus || "no status"})`); continue; }
    const dep = e.department && typeof e.department === "object" ? e.department : { department_id: e.department_id, department_name: e.department_name };
    const departmentId = text(dep.department_id, 64);
    if (departmentId && !departments.has(departmentId) && text(dep.department_name, 120)) departments.set(departmentId, { department_id: departmentId, name: text(dep.department_name, 120), code: text(dep.department_code, 30), is_active: true });
    else if (departmentId && departments.get(departmentId) && !departments.get(departmentId).code && text(dep.department_code, 30)) departments.get(departmentId).code = text(dep.department_code, 30);
    const positionTitle = typeof e.position === "object" && e.position ? (e.position.position_title ?? e.position.title ?? e.position.name) : e.position;
    const supervisorRaw = text(e.reporting_supervisor_id, 64);
    employees.push({
      employee_id: id,
      legacy_id: text(e.permanent_employee_id, 64) ? text(e.employee_id, 64) : null, // the id CRM would have used before HR gave a permanent one
      full_name: fullName,
      work_email: text(e.email ?? e.work_email, 254),
      department_id: departmentId,
      position_id: addPosition(departmentId, positionTitle),
      supervisor_employee_id: supervisorRaw ? (idIndex.get(supervisorRaw) || supervisorRaw) : null,
      employment_status: status, // null = Onboarding / Rejected
      hr_status: hrStatus,
    });
  }
  return { departments: [...departments.values()], positions: [...positions.values()], employees, skipped };
};

// ---------------------------------------------------------------- comparing and applying

const EMPLOYEE_FIELDS = ["full_name", "work_email", "department_id", "position_id", "supervisor_employee_id"];

const envelopeFor = (runId, type, entityId, data) => ({
  event_id: crypto.randomUUID(), event_type: type, schema_version: 1, source: SYSTEMS.hr, occurred_at: isoWithOffset(),
  entity_id: String(entityId).slice(0, 64), correlation_id: null,
  idempotency_key: `${HR_SYNC_ORIGIN}:${runId}:${type}:${entityId}`.slice(0, 160), data,
});

let running = false;

/*
 * One pull. Returns a summary { departments: {created, updated}, positions: {...}, employees: {created, updated, status_changed,
 * not_imported, unchanged}, skipped, missing, events, results }. Throws when HR cannot be read (nothing is changed then).
 */
export const runHrPullSync = async ({ trigger = "job" } = {}) => {
  if (!hrPullEnabled()) throw new AppError("HR pull sync is off. It runs only with INTEGRATION_HR_MODE=live and INTEGRATION_HR_SYNC=pull.", 409);
  if (running) return { skipped_run: true };
  running = true;
  const started = Date.now();
  try {
    const [rawDepartments, rawEmployees] = await Promise.all([fetchDepartments(), fetchEmployees()]);
    const mapped = mapHrData({ departments: rawDepartments, employees: rawEmployees });
    const { receiveEvent } = await import("./inboxService.js"); // here, not at the top: inboxService imports the HR adapter
    const runId = crypto.randomUUID().slice(0, 8);
    const events = [];
    const summary = {
      departments: { created: 0, updated: 0 }, positions: { created: 0, updated: 0 },
      employees: { created: 0, updated: 0, status_changed: 0, not_imported: 0, unchanged: 0, id_kept: 0 },
      skipped: { no_id: mapped.skipped.no_id, unknown_status: mapped.skipped.unknown_status }, missing: 0,
    };

    const deps = new Map((await select("SELECT department_id, name, code, is_active FROM department_references WHERE is_mock = 0")).map((r) => [r.department_id, r]));
    for (const d of mapped.departments) {
      const row = deps.get(d.department_id);
      if (!row) { events.push(envelopeFor(runId, "DepartmentCreated", d.department_id, d)); summary.departments.created += 1; continue; }
      if (row.name !== d.name || (d.code !== null && row.code !== d.code) || Boolean(row.is_active) !== d.is_active) {
        events.push(envelopeFor(runId, "DepartmentUpdated", d.department_id, d)); summary.departments.updated += 1;
      }
    }
    const pos = new Map((await select("SELECT position_id, title, department_id FROM position_references WHERE is_mock = 0")).map((r) => [r.position_id, r]));
    for (const p of mapped.positions) {
      const row = pos.get(p.position_id);
      if (!row) { events.push(envelopeFor(runId, "PositionCreated", p.position_id, p)); summary.positions.created += 1; continue; }
      if (row.title !== p.title || (row.department_id || null) !== p.department_id) { events.push(envelopeFor(runId, "PositionUpdated", p.position_id, p)); summary.positions.updated += 1; }
    }

    const emps = new Map((await select("SELECT employee_id, full_name, work_email, department_id, position_id, supervisor_employee_id, employment_status FROM employee_references WHERE is_mock = 0")).map((r) => [r.employee_id, r]));
    const seen = new Set();
    for (const e of mapped.employees) {
      let id = e.employee_id;
      let row = emps.get(id);
      if (!row && e.legacy_id && emps.get(e.legacy_id)) {
        // CRM imported this person before HR gave a permanent id: keep CRM's id so the CRM login stays linked
        id = e.legacy_id; row = emps.get(id); summary.employees.id_kept += 1;
      }
      seen.add(id);
      const status = e.employment_status || (row ? "inactive" : null);
      if (!status) { summary.employees.not_imported += 1; continue; } // Onboarding / Rejected, never imported
      const data = { employee_id: id, full_name: e.full_name, work_email: e.work_email, department_id: e.department_id, position_id: e.position_id, employment_status: status, supervisor_employee_id: e.supervisor_employee_id };
      if (!row) { events.push(envelopeFor(runId, "EmployeeCreated", id, data)); summary.employees.created += 1; continue; }
      let changed = false;
      if (row.employment_status !== status) { events.push(envelopeFor(runId, "EmployeeStatusChanged", id, { employee_id: id, employment_status: status, hr_status: e.hr_status })); summary.employees.status_changed += 1; changed = true; }
      if (EMPLOYEE_FIELDS.some((f) => (row[f] ?? null) !== (data[f] ?? null))) { events.push(envelopeFor(runId, "EmployeeUpdated", id, data)); summary.employees.updated += 1; changed = true; }
      if (!changed) summary.employees.unchanged += 1;
    }
    summary.missing = [...emps.keys()].filter((id) => !seen.has(id)).length; // in CRM but not in HR's answer: reported, never changed automatically

    const results = [];
    for (const envelope of events) {
      const out = await receiveEvent(envelope);
      results.push({ type: envelope.event_type, entity: envelope.entity_id, status: out.duplicate ? "duplicate" : out.status, note: out.note || null });
    }
    // employee account flow: new CRM-department hires get a deactivated staff account ("Waiting for ESS registration")
    const { provisionStaffAccounts } = await import("../staffAccountService.js");
    const accounts = await provisionStaffAccounts({ source: HR_SYNC_ORIGIN + " (" + trigger + ")" });
    const problems = results.filter((r) => r.status === "dead" || r.status === "failed");
    const E = summary.employees;
    let message = `HR pull (${trigger}): ${rawEmployees.length} employee(s) read; ${E.created} created, ${E.updated} updated, ${E.status_changed} status change(s), ${E.not_imported} not imported (Onboarding/Rejected), ${E.unchanged} unchanged`
      + `; departments +${summary.departments.created}/~${summary.departments.updated}, positions +${summary.positions.created}/~${summary.positions.updated}`
      + `${summary.skipped.unknown_status.length ? `; unknown status: ${summary.skipped.unknown_status.slice(0, 5).join(", ")}` : ""}${summary.missing ? `; ${summary.missing} CRM employee(s) not in HR's answer` : ""}${problems.length ? `; ${problems.length} change(s) failed (see the inbox)` : ""}`;
    if (accounts.created.length) message += "; " + accounts.created.length + " CRM staff account(s) created (waiting for ESS registration)";
    if (accounts.roleChanged.length) message += "; " + accounts.roleChanged.length + " role(s) updated from the position rules";
    await logIntegration({ direction: "sync", system: SYSTEMS.hr, endpoint: `${API}/employees`, success: problems.length === 0, mode: "live", durationMs: Date.now() - started, message });
    return { ...summary, accounts, events: events.length, results, message };
  } catch (err) {
    await logIntegration({ direction: "sync", system: SYSTEMS.hr, endpoint: `${API}/employees`, success: false, mode: "live", durationMs: Date.now() - started, message: `HR pull (${trigger}) failed, nothing changed: ${err.message}` });
    throw err;
  } finally {
    running = false;
  }
};

// One employee from JohnVivzHR (GET /employees/:identifier accepts the number, the JV-YYYY-NNNNN id or the code), in CRM's field names.
export const pullOneEmployee = async (identifier) => {
  const res = await hrGet(`/employees/${encodeURIComponent(identifier)}`);
  if (res.status === 404) return null;
  const e = unwrap(res, `employee ${identifier}`);
  const mapped = mapHrData({ departments: [], employees: [e] });
  const m = mapped.employees[0];
  if (!m || !m.employment_status) return null; // Onboarding / Rejected are not imported
  return { employee_id: m.employee_id, full_name: m.full_name, work_email: m.work_email, department_id: m.department_id, position_id: m.position_id, employment_status: m.employment_status, supervisor_employee_id: m.supervisor_employee_id };
};
