// Manager > Settings > Teams & CRM Access (phase P2; employee account flow 2026-11-16). HR employee data is shown read-only. Staff accounts
// are created from HR (services/staffAccountService.js) and activated by the first ESS sign-in; the Manager sets the team, may override
// the role from the position rules, and can switch access off. Rules live in services/accessService.js.
import { hrMode } from "../services/integration/hrAdapter.js";
import {
  listTeams, listStaffAccess, createTeam, renameTeam, setTeamLeader, setTeamActive,
  changeAssignment, setAccess, GRANTABLE_ROLES,
} from "../services/accessService.js";
import { getStaffSettings, saveStaffSettings, provisionStaffAccounts, accountState, matchPosition, STATE_LABELS, STAFF_ROLE_CHOICES, RULE_MATCHES } from "../services/staffAccountService.js";
import { essLoginMode } from "../services/essLoginService.js";
import { isDevMailbox } from "../services/mailService.js";
import { platformStatus } from "../services/dashboardService.js";
import { ROLE_LABELS } from "../helpers/labels.js";
import { AppError } from "../helpers/errors.js";
import { clean, toId, oneOf } from "../helpers/validators.js";

const BACK = "/crm/settings/access";
const cfg = { base: "/crm/settings", rules: "/crm/settings", categories: "/crm/settings/categories", templates: "/crm/settings/templates", audit: "/crm/settings/audit-logs", permissions: "/crm/settings/permissions", access: BACK, isManager: true };

// Runs one action, turns a rule violation into a flash message and always returns to the page.
const act = (fn) => async (req, res) => {
  try {
    const message = await fn(req);
    if (message) req.flash("success_msg", message);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash("error_msg", err.message);
  }
  res.redirect(BACK);
};

export const page = async (req, res) => {
  const [teams, staff, staffSettings] = await Promise.all([listTeams(), listStaffAccess(), getStaffSettings()]);
  const ruleRows = [...staffSettings.rules, ...Array.from({ length: Math.max(0, 6 - staffSettings.rules.length) }, () => ({ match: "exact", text: "", role: "" }))];
  const activeTeams = teams.filter((t) => t.is_active);
  const leaders = staff.filter((s) => s.user_id && s.role === "team_leader" && s.is_active);
  res.render("settings/access", {
    title: "Settings", tab: "access", cfg, platform: platformStatus(),
    hrMode: hrMode(), devMail: isDevMailbox(), essMode: essLoginMode(), departmentCode: staffSettings.departmentCode,
    ruleRows: ruleRows.map((r, i) => ({ ...r, i })), ruleRoleOptions: STAFF_ROLE_CHOICES.map((value) => ({ value, label: ROLE_LABELS[value] })),
    matchOptions: RULE_MATCHES.map((value) => ({ value, label: value === "exact" ? "Title is exactly" : "Title contains" })),
    reviewCount: staff.filter((s) => s.user_id && s.role_source === "position_rule" && matchPosition(s.position_title, staffSettings.rules).review).length,
    teams: teams.map((t) => ({ ...t, leaders: leaders.filter((l) => Number(l.team_id) === Number(t.id)) })),
    activeTeams,
    roleOptions: GRANTABLE_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] })),
    staff: staff.map((s) => ({
      ...s,
      roleLabel: s.role ? ROLE_LABELS[s.role] : null,
      isManagerRow: s.role === "crm_manager",
      isSelf: Number(s.user_id) === Number(req.user.id),
      hrBlocked: ["inactive", "separated"].includes(s.employment_status),
      state: accountState(s), stateLabel: STATE_LABELS[accountState(s)],
      waiting: accountState(s) === "waiting",
      viaEss: s.login_via === "ess",
      roleByHand: s.role_source === "manager",
      needsReview: Boolean(s.user_id) && s.role_source === "position_rule" && matchPosition(s.position_title, staffSettings.rules).review,
      canManage: Boolean(s.user_id) && Number(s.user_id) !== Number(req.user.id) && (s.role !== "crm_manager" || accountState(s) === "waiting"),
      canSwitch: Boolean(s.user_id) && s.role !== "crm_manager" && Number(s.user_id) !== Number(req.user.id) && accountState(s) !== "waiting",
      noAccountWhy: !s.user_id ? (["inactive", "separated"].includes(s.employment_status) ? "HR status blocks a CRM account." : !s.work_email ? "No email in HR, so no account can be created." : "An account is created at the next HR sync (or press Create accounts from HR now).") : null,
    })),
  });
};

export const teamCreate = act(async (req) => {
  const team = await createTeam({ actor: req.user, req, name: clean(req.body.name, 100) });
  return `Team "${team.name}" created (${team.team_code}). Grant CRM access to its Team Leader and agents below.`;
});

export const teamUpdate = act(async (req) => {
  const teamId = toId(req.params.id);
  if (!teamId) throw new AppError("Team not found.", 404);
  if (req.body.name !== undefined) await renameTeam({ req, teamId, name: clean(req.body.name, 100) });
  if (req.body.team_leader_id !== undefined) await setTeamLeader({ req, teamId, userId: toId(req.body.team_leader_id) });
  return "Team saved.";
});

export const teamToggle = act(async (req) => {
  const teamId = toId(req.params.id);
  if (!teamId) throw new AppError("Team not found.", 404);
  const active = req.body.active === "1";
  await setTeamActive({ req, teamId, active });
  return active ? "Team reactivated." : "Team deactivated.";
});

// "Create accounts from HR now": the same run as after every HR sync and every 5 minutes.
export const provision = act(async (req) => {
  const out = await provisionStaffAccounts({ source: `Create accounts from HR now by ${req.user.email}`, req });
  if (out.off) throw new AppError("HR is disabled (INTEGRATION_HR_MODE=disabled): no accounts can be created from it.", 409);
  const review = out.created.filter((c) => c.review).length;
  return `${out.created.length} staff account(s) created (Waiting for ESS registration)${review ? ` (${review} with a position that matched no rule: Agent, please review)` : ""}${out.roleChanged.length ? `, ${out.roleChanged.length} role(s) updated from the position rules` : ""}${out.skipped.length ? `. Not created: ${out.skipped.slice(0, 3).join("; ")}${out.skipped.length > 3 ? " …" : ""}` : "."}`;
});

export const rules = act(async (req) => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const text = req.body[`text_${i}`] ?? req.body[`contains_${i}`]; // contains_i: the form before 2026-11-16
    if (text === undefined) continue;
    rows.push({ match: req.body[`text_${i}`] !== undefined ? (oneOf(req.body[`match_${i}`], RULE_MATCHES) || "exact") : "contains", text: clean(text, 60), role: oneOf(req.body[`role_${i}`], STAFF_ROLE_CHOICES) || req.body[`role_${i}`] });
  }
  const saved = await saveStaffSettings({ req, departmentCode: clean(req.body.department_code, 30), rules: rows.filter((r) => r.text) });
  return `Saved: department ${saved.departmentCode}, ${saved.rules.length} position rule(s). New accounts and accounts whose role was not set by hand follow them at the next run.`;
});

export const assignment = act(async (req) => {
  const user = await changeAssignment({
    req, actor: req.user, userId: toId(req.params.id), role: oneOf(req.body.role, GRANTABLE_ROLES), teamId: toId(req.body.team_id), reason: clean(req.body.reason, 255),
  });
  return `${user.display_name}: role and team updated.`;
});

export const access = act(async (req) => {
  const active = req.body.active === "1";
  const { user, open, hrBlocked } = await setAccess({ req, actor: req.user, userId: toId(req.params.id), active, reason: clean(req.body.reason, 255) });
  if (active) return `${user.display_name}: CRM access enabled.${hrBlocked ? " HR still blocks this person, so they cannot sign in until HR reactivates them." : ""}`;
  return `${user.display_name}: CRM access disabled.${open ? ` ${open} active case(s) are still assigned to them; reassign them from the case pages.` : ""}`;
});
