/*
 * Teams & CRM Access (CRM Manager, Settings tab). Phase P2.
 *
 * HR owns the employee: name, position, department and employment status are read-only copies in
 * employee_references. Staff accounts are CREATED FROM HR (services/staffAccountService.js, employee account flow): deactivated,
 * "Waiting for ESS registration", no CRM password; the first sign-in with the ESS password activates them. The CRM Manager decides
 * the team, may override the role that the position rules gave, and can switch access off. Nothing here writes to an HR table.
 * (The P2 "Grant CRM access / invitation / set your password" flow for staff was replaced on 2026-11-16.)
 *
 * Rules (server-enforced; the screen only mirrors them):
 *  - Role override: Agent, Team Leader or CRM Manager; a CRM Manager account can be changed only while it is still waiting for ESS.
 *  - One active Team Leader per team.
 *  - Role or team can change only when the person has no active cases (reassign them first).
 *  - Switching access off needs a reason; the Manager cannot switch off the CRM Manager login or their own.
 *  - Re-enabling never lifts an HR block (inactive/separated stays blocked until HR says otherwise).
 *  - A team with active members cannot be deactivated.
 * Every change is audited with before/after values.
 */
import { QueryTypes, Op } from "sequelize";
import { sequelize, CrmUser, CrmTeam, ACCESS_BLOCKING_STATUSES } from "../models/index.js";
import { AppError } from "../helpers/errors.js";
import { audit } from "./auditService.js";
import { ACTIVE_SQL } from "./caseService.js";
import { getStaffSettings, STAFF_ROLE_CHOICES } from "./staffAccountService.js";

export const GRANTABLE_ROLES = STAFF_ROLE_CHOICES; // the roles the Manager can set by hand
const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
const need = (cond, message, status = 422) => { if (!cond) throw new AppError(message, status); };
const reasonOf = (reason) => {
  const r = String(reason || "").trim();
  need(r.length >= 5 && r.length <= 255, "Enter a reason of 5–255 characters; it is kept in the audit log.");
  return r;
};

const activeCaseCount = async (userId, transaction) =>
  Number((await select(`SELECT COUNT(*) AS n FROM customer_cases k WHERE k.assigned_agent_id = :userId AND ${ACTIVE_SQL()}`, { userId }, transaction))[0].n);

// ---------------------------------------------------------------- read models

export const listTeams = () =>
  select(
    `SELECT t.id, t.team_code, t.name, t.is_active, t.team_leader_id, l.display_name AS leader_name,
            (SELECT COUNT(*) FROM crm_users u WHERE u.team_id = t.id AND u.role = 'agent' AND u.is_active = 1 AND u.access_revoked_at IS NULL) AS agent_count,
            (SELECT COUNT(*) FROM crm_users u WHERE u.team_id = t.id AND u.is_active = 1 AND u.access_revoked_at IS NULL) AS member_count,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.team_id = t.id AND ${ACTIVE_SQL()}) AS active_cases
     FROM crm_teams t LEFT JOIN crm_users l ON l.id = t.team_leader_id
     ORDER BY t.is_active DESC, t.team_code`
  );

// The CRM department's HR employees (and anyone else who has a CRM login) with the CRM state beside it. HR columns are shown, never edited.
export const listStaffAccess = async () =>
  select(
    `SELECT e.employee_id, e.full_name, e.work_email, e.employment_status, e.is_mock, e.last_synced_at,
            p.title AS position_title, d.name AS department_name, d.code AS department_code,
            u.id AS user_id, u.role, u.role_source, u.team_id, u.is_active, u.access_revoked_at, u.access_revoked_reason,
            u.email_verified_at, u.last_login_at, u.login_via, u.ess_activated_at, t.name AS team_name,
            (SELECT COUNT(*) FROM customer_cases k WHERE k.assigned_agent_id = u.id AND ${ACTIVE_SQL()}) AS active_cases
     FROM employee_references e
     LEFT JOIN position_references p ON p.position_id = e.position_id
     LEFT JOIN department_references d ON d.department_id = e.department_id
     LEFT JOIN crm_users u ON u.employee_id = e.employee_id
     LEFT JOIN crm_teams t ON t.id = u.team_id
     WHERE u.id IS NOT NULL OR UPPER(d.code) = UPPER(:dept)
     ORDER BY (u.id IS NULL), FIELD(u.role, 'crm_manager', 'team_leader', 'agent'), e.full_name`,
    { dept: (await getStaffSettings()).departmentCode }
  );

// ---------------------------------------------------------------- teams

const nextTeamCode = async (transaction) => {
  const [row] = await select("SELECT COALESCE(MAX(CAST(SUBSTRING(team_code, 6) AS UNSIGNED)), 0) AS n FROM crm_teams WHERE team_code REGEXP '^TEAM-[0-9]+$'", {}, transaction);
  return `TEAM-${String(Number(row.n) + 1).padStart(2, "0")}`;
};

export const createTeam = async ({ actor, req, name }) => {
  const clean = String(name || "").trim();
  need(clean.length >= 3 && clean.length <= 100, "Team name must be 3–100 characters.");
  need(!(await CrmTeam.count({ where: { name: clean } })), "A team with this name already exists.");
  const team = await sequelize.transaction(async (transaction) => CrmTeam.create({ team_code: await nextTeamCode(transaction), name: clean, manager_id: actor.id }, { transaction }));
  await audit(req, "team_created", { recordType: "crm_team", recordId: team.id, after: { team_code: team.team_code, name: clean } });
  return team;
};

export const renameTeam = async ({ req, teamId, name }) => {
  const team = await CrmTeam.findByPk(teamId);
  need(team, "Team not found.", 404);
  const clean = String(name || "").trim();
  need(clean.length >= 3 && clean.length <= 100, "Team name must be 3–100 characters.");
  need(!(await CrmTeam.count({ where: { name: clean, id: { [Op.ne]: team.id } } })), "A team with this name already exists.");
  if (clean === team.name) return team;
  const before = { name: team.name };
  await team.update({ name: clean });
  await audit(req, "team_renamed", { recordType: "crm_team", recordId: team.id, before, after: { name: clean } });
  return team;
};

export const setTeamLeader = async ({ req, teamId, userId }) => {
  const team = await CrmTeam.findByPk(teamId);
  need(team, "Team not found.", 404);
  let leader = null;
  if (userId) {
    leader = await CrmUser.findOne({ where: { id: userId, role: "team_leader", team_id: team.id, is_active: true } });
    need(leader, "Choose an active Team Leader who belongs to this team.");
  }
  const before = { team_leader_id: team.team_leader_id };
  await team.update({ team_leader_id: leader ? leader.id : null });
  await audit(req, "team_leader_set", { recordType: "crm_team", recordId: team.id, before, after: { team_leader_id: leader ? leader.id : null } });
};

export const setTeamActive = async ({ req, teamId, active }) => {
  const team = await CrmTeam.findByPk(teamId);
  need(team, "Team not found.", 404);
  if (!active) {
    const members = Number((await select("SELECT COUNT(*) AS n FROM crm_users WHERE team_id = :id AND is_active = 1 AND access_revoked_at IS NULL", { id: team.id }))[0].n);
    need(members === 0, `This team still has ${members} active member(s). Move them to another team first.`);
  }
  if (Boolean(team.is_active) === Boolean(active)) return team;
  await team.update({ is_active: Boolean(active) });
  await audit(req, active ? "team_reactivated" : "team_deactivated", { recordType: "crm_team", recordId: team.id, before: { is_active: !active }, after: { is_active: Boolean(active) } });
  return team;
};

// ---------------------------------------------------------------- change / switch off

const loadStaffTarget = async (userId, actor, { allowWaitingManager = false } = {}) => {
  const user = await CrmUser.findOne({ where: { id: userId, user_type: "staff" } });
  need(user, "Staff login not found.", 404);
  need(user.id !== actor.id, "You cannot change your own access.", 403);
  const waiting = user.login_via === "ess" && !user.ess_activated_at;
  need(user.role !== "crm_manager" || (allowWaitingManager && waiting), "The CRM Manager login is managed by the setup administrator.", 403);
  return user;
};

export const changeAssignment = async ({ req, actor, userId, role, teamId, reason }) => {
  const user = await loadStaffTarget(userId, actor, { allowWaitingManager: true });
  need(GRANTABLE_ROLES.includes(role), "Choose Agent, Team Leader or CRM Manager.");
  const why = reasonOf(reason);
  const result = await sequelize.transaction(async (transaction) => {
    const [found] = teamId ? await select("SELECT id, name, is_active, team_leader_id FROM crm_teams WHERE id = :teamId FOR UPDATE", { teamId }, transaction) : [];
    const team = found || (role === "crm_manager" ? { id: null, name: null, is_active: 1, team_leader_id: null } : null);
    need(team && team.is_active, "Choose an active team.");
    if (user.role === role && Number(user.team_id || 0) === Number(team.id || 0)) throw new AppError("Nothing to change: the role and team are already set.", 422);
    const open = await activeCaseCount(user.id, transaction);
    need(open === 0, `${user.display_name} still has ${open} active case(s). Reassign them first, then change the role or team.`);
    if (role === "team_leader") need(!team.team_leader_id || Number(team.team_leader_id) === Number(user.id), "This team already has a Team Leader. Change the leader first.");
    const before = { role: user.role, team_id: user.team_id, role_source: user.role_source };
    // The person stops leading the old team when their role or team changes.
    await sequelize.query("UPDATE crm_teams SET team_leader_id = NULL WHERE team_leader_id = :id", { replacements: { id: user.id }, transaction });
    // a role chosen by hand is never changed again by the position rules
    await user.update({ role, team_id: team.id, ...(role !== user.role ? { role_source: "manager" } : {}) }, { transaction });
    if (role === "team_leader") await sequelize.query("UPDATE crm_teams SET team_leader_id = :id WHERE id = :teamId", { replacements: { id: user.id, teamId: team.id }, transaction });
    return { before, after: { role, team_id: team.id, team: team.name, role_source: role !== before.role ? "manager" : before.role_source } };
  });
  await audit(req, "crm_access_changed", { recordType: "crm_user", recordId: user.id, reason: why, before: result.before, after: result.after });
  return user;
};

export const setAccess = async ({ req, actor, userId, active, reason }) => {
  const user = await loadStaffTarget(userId, actor);
  const why = reasonOf(reason);
  if (Boolean(user.is_active) === Boolean(active)) throw new AppError(`CRM access is already ${active ? "enabled" : "disabled"}.`, 422);
  need(!(active && user.login_via === "ess" && !user.ess_activated_at), "This account is waiting for ESS registration. It becomes active by itself the first time the person signs in with the ESS password.");
  const open = active ? 0 : await activeCaseCount(user.id);
  await user.update({ is_active: Boolean(active) });
  await audit(req, active ? "crm_access_enabled" : "crm_access_disabled", {
    recordType: "crm_user", recordId: user.id, reason: why,
    before: { is_active: !active }, after: { is_active: Boolean(active) },
    details: open ? `${open} active case(s) still assigned` : null,
  });
  const [hr] = await select("SELECT employment_status FROM employee_references WHERE employee_id = :id", { id: user.employee_id });
  return { user, open, hrBlocked: Boolean(active) && (ACCESS_BLOCKING_STATUSES.includes(hr?.employment_status) || Boolean(user.access_revoked_at)) };
};

