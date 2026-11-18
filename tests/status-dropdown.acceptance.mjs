/*
 * JOHNVIVZ CRM — "Update status" dropdown tests (case detail page).
 *   npm run test:status        (npm test runs it after the P1, P2 and UI suites)
 * The rules come from docs/phase-reports/P1.md §6. The dropdown is only a convenience: the first half checks
 * which options each role is offered for each status, the second half proves the server enforces the same rules
 * (reason / resolution required, invalid jumps refused and audited) even when the form is forged.
 */
import { check, startEnvironment, summarize } from "./support/harness.mjs";

const DB = process.env.TEST_STATUS_DB_NAME || "johnvivz_crm_status_test";
const PORT = Number(process.env.TEST_STATUS_PORT || 3196);
const env = await startEnvironment({ dbName: DB, port: PORT, fixtures: false });
console.log(`\nJOHNVIVZ CRM status-dropdown tests — database ${DB}\n`);
check("ENV-01", "Migrations and demo seed load; server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.serverLog());

const { all, one, db, as } = env;
const ALL_STATUSES = ["open", "assigned", "in_progress", "waiting_for_customer", "escalated", "resolved", "closed"];
const LABEL = { open: "Open", assigned: "Assigned", in_progress: "In Progress", waiting_for_customer: "Waiting for Customer", escalated: "Escalated", resolved: "Resolved", closed: "Closed" };

// ---------------------------------------------------------------- page parsing
const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const parseDropdown = (html) => {
  const m = html.match(/<select name="status"[^>]*>([\s\S]*?)<\/select>/);
  if (!m) return null;
  const options = [...m[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((o) => ({
    value: o[1], disabled: /\bdisabled\b/.test(o[2]), requires: (o[2].match(/data-requires="([^"]*)"/) || [])[1] || "", label: decode(o[3]).trim(),
  }));
  return { current: options[0], choices: options.slice(1) };
};
const explanation = (html) => { const m = html.match(/id="status-explanation"[^>]*>([^<]*)</); return m ? decode(m[1]).trim() : null; };
const alerts = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => decode(m[1]));

try {
  const kristine = await one("SELECT id, team_id FROM crm_users WHERE email = 'kristine.bautista@johnvivz.test'");
  const maria = await one("SELECT id FROM crm_users WHERE email = 'maria.santos@johnvivz.test'");
  const manager = await one("SELECT id FROM crm_users WHERE email = 'manager@johnvivz.test'");
  const [c1, c2, c3] = await all("SELECT id, customer_id FROM customer_cases WHERE is_demo = 1 ORDER BY id LIMIT 3");
  const agent = await as("kristine.bautista@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const mgr = await as("manager@johnvivz.test");
  const juan = await as("juan.cruz@johnvivz.test");
  const who = { agent, tl, mgr };
  const juanCustomerId = (await one("SELECT customer_id FROM customer_accounts ca JOIN crm_users u ON u.id = ca.user_id WHERE u.email = 'juan.cruz@johnvivz.test'")).customer_id;

  // Put a case into an exact state (the matrix does not depend on the demo data).
  const setState = async (id, { status, level = 0, assigned = true, resolvedDaysAgo = null, closedDaysAgo = null, customerId = null }) => {
    await db.query("DELETE FROM ticket_escalations WHERE case_id = ?", [id]);
    await db.query(
      `UPDATE customer_cases SET status = ?, escalation_level = ?, assigned_agent_id = ?, team_id = ?, reopen_count = 0,
         resolved_at = ${resolvedDaysAgo === null ? "NULL" : "NOW() - INTERVAL ? DAY"}, closed_at = ${closedDaysAgo === null ? "NULL" : "NOW() - INTERVAL ? DAY"}
         ${customerId ? ", customer_id = ?" : ""} WHERE id = ?`,
      [status, level, assigned ? kristine.id : null, assigned ? kristine.team_id : null,
        ...(resolvedDaysAgo === null ? [] : [resolvedDaysAgo]), ...(closedDaysAgo === null ? [] : [closedDaysAgo]), ...(customerId ? [customerId] : []), id]
    );
  };
  const caseRow = (id) => one("SELECT status, escalation_level, assigned_agent_id, resolved_at, closed_at, reopen_count FROM customer_cases WHERE id = ?", [id]);
  const view = async (who_, id) => (await who_.get(`/crm/cases/${id}`)).body;
  const NO = "-";

  // ================================================================ 1. what the dropdown shows
  const MATRIX = [
    ["Assigned", { status: "assigned" }, { agent: ["in_progress", "waiting_for_customer", "escalated"], tl: ["in_progress", "waiting_for_customer"], mgr: ["in_progress", "waiting_for_customer"] }],
    ["In Progress", { status: "in_progress" }, { agent: ["waiting_for_customer", "resolved", "escalated"], tl: ["waiting_for_customer", "resolved"], mgr: ["waiting_for_customer", "resolved"] }],
    ["Waiting for Customer", { status: "waiting_for_customer" }, { agent: ["in_progress", "escalated"], tl: ["in_progress"], mgr: ["in_progress"] }],
    ["Escalated (level 1)", { status: "escalated", level: 1 }, { agent: NO, tl: ["escalated"], mgr: NO }],
    ["Escalated (level 2)", { status: "escalated", level: 2 }, { agent: NO, tl: NO, mgr: NO }],
    ["Resolved (inside window)", { status: "resolved", resolvedDaysAgo: 1 }, { agent: NO, tl: ["closed", "in_progress"], mgr: ["closed", "in_progress"] }],
    ["Closed (inside window)", { status: "closed", resolvedDaysAgo: 2, closedDaysAgo: 1 }, { agent: NO, tl: ["in_progress"], mgr: ["in_progress"] }],
    ["Resolved (window passed)", { status: "resolved", resolvedDaysAgo: 30 }, { agent: NO, tl: ["closed"], mgr: ["closed"] }],
    ["Closed (window passed)", { status: "closed", resolvedDaysAgo: 40, closedDaysAgo: 30 }, { agent: NO, tl: NO, mgr: NO }],
  ];
  const REQUIRES = { escalated: "reason", resolved: "resolution" };
  const seenValues = new Set();
  for (const [name, state, expected] of MATRIX) {
    await setState(c1.id, state);
    const wrong = [];
    for (const role of ["agent", "tl", "mgr"]) {
      const html = await view(who[role], c1.id);
      const dd = parseDropdown(html);
      const want = expected[role];
      if (want === NO) {
        if (dd) wrong.push(`${role}: dropdown should be replaced by an explanation, got [${dd.choices.map((c) => c.value)}]`);
        else if (!explanation(html)) wrong.push(`${role}: no explanation shown`);
        continue;
      }
      if (!dd) { wrong.push(`${role}: no dropdown`); continue; }
      if (explanation(html)) wrong.push(`${role}: explanation shown next to a dropdown`);
      const got = dd.choices.map((c) => c.value);
      got.forEach((v) => seenValues.add(v));
      if (got.join() !== want.join()) wrong.push(`${role}: [${got}] expected [${want}]`);
      if (!(dd.current.value === "" && dd.current.disabled && dd.current.label === `Current: ${LABEL[state.status]}`)) wrong.push(`${role}: first option is not the disabled "Current: ${LABEL[state.status]}" (${JSON.stringify(dd.current)})`);
      for (const c of dd.choices) if ((REQUIRES[c.value] || "") !== c.requires) wrong.push(`${role}: ${c.value} requires "${c.requires}"`);
    }
    check("DD", `${name}: agent / Team Leader / Manager see the right options`, wrong.length === 0, wrong.join("; "));
  }

  // The explanations name the reason.
  await setState(c1.id, { status: "escalated", level: 1 });
  const escAgent = explanation(await view(agent, c1.id)) || "";
  await setState(c1.id, { status: "resolved", resolvedDaysAgo: 1 });
  const resAgent = explanation(await view(agent, c1.id)) || "";
  await setState(c1.id, { status: "closed", resolvedDaysAgo: 2, closedDaysAgo: 1 });
  const closedAgent = explanation(await view(agent, c1.id)) || "";
  await setState(c1.id, { status: "closed", resolvedDaysAgo: 40, closedDaysAgo: 30 });
  const lateTl = explanation(await view(tl, c1.id)) || "";
  await setState(c1.id, { status: "open", assigned: false });
  const openTl = explanation(await view(tl, c1.id)) || "";
  check("DD-X", "Instead of an empty dropdown the agent sees why: Escalated = internal notes only; Resolved/Closed = who can reopen; late TL = window passed; Open = assign first",
    /internal notes/.test(escAgent) && /Agents can't change a Resolved case.*customer.*Team Leader.*CRM Manager/.test(resAgent) &&
    /Closed case.*Team Leader or the CRM Manager can reopen/.test(closedAgent) && /reopen window has passed/.test(lateTl) && /assigns an agent/.test(openTl),
    JSON.stringify({ escAgent, resAgent, closedAgent, lateTl, openTl }));

  const enumRow = await one("SELECT column_type t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'customer_cases' AND column_name = 'status'", [DB]);
  const enumValues = [...String(enumRow.t || enumRow.COLUMN_TYPE).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check("DD-S", "No new statuses: the status column still has the 7 statuses and no dropdown offers anything else (no \"Unsolved\")",
    enumValues.join() === ALL_STATUSES.join() && [...seenValues].every((v) => ALL_STATUSES.includes(v) && v !== "open"), `${enumValues} / ${[...seenValues]}`);

  // ================================================================ 2. escalate from the dropdown = escalate button
  const auditCount = async (action, id) => Number((await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = ? AND record_id = ?", [action, String(id)])).n);
  const escRows = (id) => all("SELECT from_level, to_level, escalated_by, escalated_to, reason, outcome FROM ticket_escalations WHERE case_id = ? ORDER BY id", [id]);
  const REASON = "Customer asks for a supervisor";

  await setState(c1.id, { status: "in_progress" });
  await agent.get(`/crm/cases/${c1.id}`);
  const noReason = await agent.post(`/crm/cases/${c1.id}/status`, { status: "escalated", note: "" });
  const shortReason = await agent.post(`/crm/cases/${c1.id}/status`, { status: "escalated", note: "ab" });
  const blankReason = await agent.post(`/crm/cases/${c1.id}/status`, { status: "escalated", note: "      " });
  const flashNoReason = alerts((await agent.get(`/crm/cases/${c1.id}`)).body).join(" | ");
  const afterNoReason = await caseRow(c1.id);
  check("ESC-1", "Escalated without a reason (empty, too short, blank) is rejected: status unchanged, no escalation row",
    [noReason, shortReason, blankReason].every((r) => r.status === 302) && afterNoReason.status === "in_progress" && afterNoReason.escalation_level === 0 &&
    (await escRows(c1.id)).length === 0 && /reason for the escalation/i.test(flashNoReason), `${JSON.stringify(afterNoReason)} / ${flashNoReason}`);

  await agent.post(`/crm/cases/${c1.id}/status`, { status: "escalated", note: REASON });
  const viaDropdown = { row: await caseRow(c1.id), esc: await escRows(c1.id), audit: await auditCount("case_escalated", c1.id) };

  await setState(c2.id, { status: "in_progress" });
  await agent.get(`/crm/cases/${c2.id}`);
  await agent.post(`/crm/cases/${c2.id}/escalate`, { reason: REASON });
  const viaButton = { row: await caseRow(c2.id), esc: await escRows(c2.id), audit: await auditCount("case_escalated", c2.id) };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check("ESC-2", "Escalated from the dropdown does exactly what the Escalate button does (same escalation row, level, target, reason, audit entry)",
    viaDropdown.row.status === "escalated" && viaDropdown.row.escalation_level === 1 && viaDropdown.esc.length === 1 && viaDropdown.esc[0].escalated_to === maria.id &&
    viaDropdown.esc[0].reason === REASON && same(viaDropdown.esc, viaButton.esc) && viaDropdown.row.status === viaButton.row.status &&
    viaDropdown.row.escalation_level === viaButton.row.escalation_level && viaDropdown.audit === 1 && viaButton.audit === 1,
    JSON.stringify({ viaDropdown, viaButton }));
  const hist = await all("SELECT field, old_value, new_value, note FROM case_status_history WHERE case_id = ? AND field IN ('escalation','status') ORDER BY id DESC LIMIT 2", [c1.id]);
  check("ESC-3", "The reason is kept in the case history", hist.some((h) => h.field === "escalation" && h.note === REASON) && hist.some((h) => h.field === "status" && h.new_value === "escalated"), JSON.stringify(hist));

  // ================================================================ 3. Resolved needs a resolution
  await setState(c3.id, { status: "in_progress", customerId: juanCustomerId });
  await db.query("DELETE FROM case_comments WHERE case_id = ?", [c3.id]);
  await agent.get(`/crm/cases/${c3.id}`);
  await agent.post(`/crm/cases/${c3.id}/status`, { status: "resolved", note: "" });
  await agent.post(`/crm/cases/${c3.id}/status`, { status: "resolved", note: "   " });
  await agent.post(`/crm/cases/${c3.id}/status`, { status: "resolved", note: "ok" });
  const flashNoRes = alerts((await agent.get(`/crm/cases/${c3.id}`)).body).join(" | ");
  const unresolved = await caseRow(c3.id);
  check("RES-1", "Resolved without a resolution note (empty, blank, too short) is rejected: status stays In Progress",
    unresolved.status === "in_progress" && unresolved.resolved_at === null && /resolution/i.test(flashNoRes), `${JSON.stringify(unresolved)} / ${flashNoRes}`);
  await agent.post(`/crm/cases/${c3.id}/status`, { status: "resolved", note: "Replacement sent and confirmed by phone" });
  const resolvedRow = await caseRow(c3.id);
  const resHist = await one("SELECT old_value, note FROM case_status_history WHERE case_id = ? AND field = 'status' AND new_value = 'resolved' ORDER BY id DESC LIMIT 1", [c3.id]);
  check("RES-2", "Resolved with a resolution note works and the note is saved in the history",
    resolvedRow.status === "resolved" && resolvedRow.resolved_at && resHist?.note === "Replacement sent and confirmed by phone", JSON.stringify({ resolvedRow, resHist }));
  const resComment = await one("SELECT visibility, body, author_id FROM case_comments WHERE case_id = ? AND body LIKE 'Resolution:%'", [c3.id]);
  const resCount = await one("SELECT COUNT(*) n FROM case_comments WHERE case_id = ?", [c3.id]);
  const juanSees = (await juan.get(`/portal/cases/${c3.id}`)).body;
  const firstResp = await one("SELECT first_response_at FROM customer_cases WHERE id = ?", [c3.id]);
  check("RES-3", "The resolution note is posted as ONE public comment \"Resolution: …\" that the customer can read on their case page (none was posted by the rejected attempts)",
    Number(resCount.n) === 1 && resComment?.visibility === "public" && resComment.author_id === kristine.id &&
    resComment.body === "Resolution: Replacement sent and confirmed by phone" && juanSees.includes("Resolution: Replacement sent and confirmed by phone") && firstResp.first_response_at, JSON.stringify({ resCount, resComment, firstResp }));
  check("HIST", "History records the real previous status (In Progress → Resolved, not Resolved → Resolved)", resHist?.old_value === "in_progress", JSON.stringify(resHist));

  // ================================================================ 4. supervisor actions: the Handle escalation panel is their only place
  // c1 is escalated to level 1 (Maria) from section 2.
  await tl.get(`/crm/cases/${c1.id}`);
  await tl.post(`/crm/cases/${c1.id}/escalation`, { action: "resolve", note: "" });
  const stillEsc = await caseRow(c1.id);
  const pending = await one("SELECT COUNT(*) n FROM ticket_escalations WHERE case_id = ? AND outcome = 'pending'", [c1.id]);
  check("SUP-1", "Panel: Resolve on an Escalated case without a resolution is rejected (still Escalated, escalation still pending, no comment)",
    stillEsc.status === "escalated" && Number(pending.n) === 1 && Number((await one("SELECT COUNT(*) n FROM case_comments WHERE case_id = ? AND body LIKE 'Resolution:%'", [c1.id])).n) === 0, JSON.stringify({ stillEsc, pending }));
  await tl.post(`/crm/cases/${c1.id}/escalation`, { action: "return", note: "Try again with the receipt" });
  const returned = await caseRow(c1.id);
  const returnedEsc = await escRows(c1.id);
  check("SUP-2", "Panel: \"Return to the assigned agent\" sets Assigned, level 0, escalation outcome returned",
    returned.status === "assigned" && returned.escalation_level === 0 && returnedEsc[0].outcome === "returned", JSON.stringify({ returned, returnedEsc }));

  // c2 is escalated to level 1 by the button: the Team Leader escalates again through the dropdown, the Manager takes over in the panel, then resolves.
  await tl.get(`/crm/cases/${c2.id}`);
  await tl.post(`/crm/cases/${c2.id}/status`, { status: "escalated", note: "" });
  const lvl1 = await caseRow(c2.id);
  await tl.post(`/crm/cases/${c2.id}/status`, { status: "escalated", note: "Refund above my limit" });
  const lvl2 = await caseRow(c2.id);
  const chain = await escRows(c2.id);
  check("SUP-3", "Team Leader: Escalated (to the CRM Manager) needs a reason, then moves the case to level 2 with the Manager as target",
    lvl1.escalation_level === 1 && lvl2.escalation_level === 2 && chain.length === 2 && chain[0].outcome === "escalated" && chain[1].escalated_to === manager.id, JSON.stringify({ lvl1, lvl2, chain }));
  await mgr.get(`/crm/cases/${c2.id}`);
  await mgr.post(`/crm/cases/${c2.id}/escalation`, { action: "take_over" });
  const took = await caseRow(c2.id);
  const tookEsc = await escRows(c2.id);
  check("SUP-4", "Panel: Manager \"Take over\" sets In Progress and closes the pending escalation as handled",
    took.status === "in_progress" && tookEsc[1].outcome === "handled", JSON.stringify({ took, tookEsc }));
  await mgr.post(`/crm/cases/${c2.id}/status`, { status: "resolved", note: "Refund approved and issued" });
  const mgrComment = await one("SELECT visibility, body, author_id FROM case_comments WHERE case_id = ? AND body LIKE 'Resolution:%' ORDER BY id DESC LIMIT 1", [c2.id]);
  check("SUP-5", "Manager resolves from the dropdown with a resolution note, which is posted as a public comment",
    (await caseRow(c2.id)).status === "resolved" && mgrComment?.visibility === "public" && mgrComment.body === "Resolution: Refund approved and issued" && mgrComment.author_id === manager.id, JSON.stringify(mgrComment));

  // c1 (returned, Assigned) is escalated again by the agent; the Team Leader resolves it in the panel.
  await agent.post(`/crm/cases/${c1.id}/status`, { status: "escalated", note: "Customer insists on a supervisor" });
  await tl.post(`/crm/cases/${c1.id}/escalation`, { action: "resolve", note: "Receipt checked, order credited" });
  const tlComment = await one("SELECT visibility, body, author_id FROM case_comments WHERE case_id = ? AND body LIKE 'Resolution:%' ORDER BY id DESC LIMIT 1", [c1.id]);
  check("RES-4", "Resolving from the Handle escalation panel also posts the public \"Resolution: …\" comment",
    (await caseRow(c1.id)).status === "resolved" && tlComment?.visibility === "public" && tlComment.body === "Resolution: Receipt checked, order credited" && tlComment.author_id === maria.id, JSON.stringify(tlComment));

  // Supervisor actions are not dropdown choices: a forged status POST is refused (see INV below) and the pages point to the panel.
  await setState(c1.id, { status: "escalated", level: 1 });
  const hintTl = (await view(tl, c1.id)).includes("Use the Handle escalation panel");
  const hintMgr = (await view(mgr, c1.id)).includes("Use the Handle escalation panel");
  await setState(c1.id, { status: "escalated", level: 2 });
  const hintMgr2 = (await view(mgr, c1.id)).includes("Use the Handle escalation panel") && explanation(await view(mgr, c1.id)) === "Use the Handle escalation panel to take over, return the case to the agent or resolve it.";
  const hintAgent = (await view(agent, c1.id)).includes("Use the Handle escalation panel");
  check("SUP-6", "Escalated case: Team Leader / Manager are pointed to the Handle escalation panel (no supervisor actions in the dropdown); the agent is not", hintTl && hintMgr && hintMgr2 && !hintAgent, `${hintTl}/${hintMgr}/${hintMgr2}/${hintAgent}`);

  // ================================================================ 5. invalid jumps are refused and audited
  const INVALID = [
    ["agent", "Assigned → Resolved", { status: "assigned" }, "resolved"],
    ["agent", "In Progress → Closed", { status: "in_progress" }, "closed"],
    ["agent", "In Progress → Assigned", { status: "in_progress" }, "assigned"],
    ["agent", "In Progress → Open", { status: "in_progress" }, "open"],
    ["agent", "In Progress → In Progress (same status)", { status: "in_progress" }, "in_progress"],
    ["agent", "Waiting for Customer → Resolved", { status: "waiting_for_customer" }, "resolved"],
    ["agent", "Escalated → In Progress (forged take over)", { status: "escalated", level: 1 }, "in_progress"],
    ["agent", "Escalated → Resolved (forged)", { status: "escalated", level: 1 }, "resolved"],
    ["tl", "Escalated → In Progress (take over belongs to the panel)", { status: "escalated", level: 1 }, "in_progress"],
    ["tl", "Escalated → Assigned (return belongs to the panel)", { status: "escalated", level: 1 }, "assigned"],
    ["tl", "Escalated → Resolved (resolve belongs to the panel)", { status: "escalated", level: 1 }, "resolved"],
    ["mgr", "Escalated → In Progress (take over belongs to the panel)", { status: "escalated", level: 2 }, "in_progress"],
    ["mgr", "Escalated → Resolved (resolve belongs to the panel)", { status: "escalated", level: 2 }, "resolved"],
    ["agent", "Escalated → Waiting for Customer", { status: "escalated", level: 1 }, "waiting_for_customer"],
    ["agent", "Resolved → Closed", { status: "resolved", resolvedDaysAgo: 1 }, "closed"],
    ["agent", "Resolved → In Progress (agents cannot reopen)", { status: "resolved", resolvedDaysAgo: 1 }, "in_progress"],
    ["agent", "Closed → In Progress (agents cannot reopen)", { status: "closed", resolvedDaysAgo: 2, closedDaysAgo: 1 }, "in_progress"],
    ["agent", "In Progress → \"unsolved\" (there is no such status)", { status: "in_progress" }, "unsolved"],
    ["tl", "In Progress → Escalated at level 0 (a Team Leader escalates only level 1)", { status: "in_progress" }, "escalated"],
    ["tl", "Open → In Progress (only assignment moves an Open case)", { status: "open", assigned: false }, "in_progress"],
    ["tl", "Escalated level 2 → In Progress (Manager only)", { status: "escalated", level: 2 }, "in_progress"],
    ["tl", "Closed → In Progress after the reopen window", { status: "closed", resolvedDaysAgo: 40, closedDaysAgo: 30 }, "in_progress"],
    ["tl", "Waiting for Customer → Resolved", { status: "waiting_for_customer" }, "resolved"],
    ["mgr", "In Progress → Escalated (the Manager is the top of the chain)", { status: "in_progress" }, "escalated"],
    ["mgr", "Assigned → Resolved", { status: "assigned" }, "resolved"],
    ["mgr", "Resolved → Waiting for Customer", { status: "resolved", resolvedDaysAgo: 1 }, "waiting_for_customer"],
  ];
  const failures = [];
  for (const [role, name, state, target] of INVALID) {
    await setState(c1.id, state);
    const client = who[role];
    await client.get(`/crm/cases/${c1.id}`);
    const beforeRow = await caseRow(c1.id);
    const beforeAudit = await auditCount("case_status_rejected", c1.id);
    const beforeEsc = (await escRows(c1.id)).length;
    const res = await client.post(`/crm/cases/${c1.id}/status`, { status: target, note: "Forged request, long enough note" });
    const flash = alerts((await client.get(`/crm/cases/${c1.id}`)).body).join(" | ");
    const afterRow = await caseRow(c1.id);
    const entry = await one("SELECT outcome, actor_role FROM crm_audit_logs WHERE action = 'case_status_rejected' AND record_id = ? ORDER BY id DESC LIMIT 1", [String(c1.id)]);
    const problems = [];
    if (res.status !== 302) problems.push(`HTTP ${res.status}`);
    if (JSON.stringify(afterRow) !== JSON.stringify(beforeRow)) problems.push(`case changed to ${afterRow.status}`);
    if ((await escRows(c1.id)).length !== beforeEsc) problems.push("escalation row created");
    if ((await auditCount("case_status_rejected", c1.id)) !== beforeAudit + 1 || entry?.outcome !== "denied") problems.push("not audited");
    if (!/can't change|valid status/i.test(flash)) problems.push(`no error shown (${flash})`);
    if (problems.length) failures.push(`${role} ${name}: ${problems.join(", ")}`);
  }
  check("INV", `${INVALID.length} invalid jumps by agent / Team Leader / Manager: error shown, nothing changed, each refusal audited (case_status_rejected, denied)`, failures.length === 0, failures.join("; "));

  // A customer cannot use the staff transitions either.
  await setState(c1.id, { status: "in_progress", customerId: (await one("SELECT customer_id FROM customer_accounts ca JOIN crm_users u ON u.id = ca.user_id WHERE u.email = 'juan.cruz@johnvivz.test'")).customer_id });
  await juan.get(`/portal/cases/${c1.id}`);
  const custAudit = await auditCount("case_status_rejected", c1.id);
  for (const target of ["resolved", "escalated", "closed", "waiting_for_customer"]) await juan.post(`/portal/cases/${c1.id}/status`, { status: target, note: "Forged request, long enough note" });
  const custAfter = await caseRow(c1.id);
  check("INV-C", "A customer cannot set Resolved / Escalated / Closed / Waiting on an In Progress case (refused and audited)",
    custAfter.status === "in_progress" && (await auditCount("case_status_rejected", c1.id)) === custAudit + 4, JSON.stringify(custAfter));

  // The status-change audit for a valid change still exists.
  check("AUD", "Valid dropdown changes are audited (case_status_changed / case_escalated / escalation_handled)",
    (await auditCount("case_status_changed", c3.id)) >= 1 && (await auditCount("case_escalated", c1.id)) >= 1 && (await auditCount("escalation_handled", c2.id)) >= 1);
} catch (err) {
  check("RUN", "Tests ran without an unexpected error", false, err.stack || String(err));
} finally {
  await env.stop();
  summarize(DB);
}
