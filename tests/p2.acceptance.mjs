/*
 * JOHNVIVZ CRM — Phase P2 acceptance tests (identity & roles).
 *   npm run test:p2        (npm test runs P1 and P2)
 * Throwaway database johnvivz_crm_p2_test; people beyond the 7 demo accounts come from
 * tests/support/p1Fixtures.mjs and from rows this file inserts. Covers: email verification, password
 * reset by email, the Teams & CRM Access screen, TC-06 (HR reference updates, mock mode) and a
 * per-role page check. TC-05 in live HR mode needs the signed inbound endpoint and is part of P6.
 */
import crypto from "crypto";
import { check, startEnvironment, summarize, PASSWORD } from "./support/harness.mjs";

const DB = process.env.TEST_P2_DB_NAME || "johnvivz_crm_p2_test";
const PORT = Number(process.env.TEST_P2_PORT || 3197);
const env = await startEnvironment({ dbName: DB, port: PORT, extraEnv: { ACCOUNT_RATE_LIMIT_MAX: "40" } });
console.log(`\nJOHNVIVZ CRM P2 acceptance tests — database ${DB}\n`);
check("ENV-01", "Migrations, demo seed and test fixtures load; server starts", env.steps.migrate.status === 0 && env.steps.seed.status === 0 && env.steps.fixtures.status === 0 && env.up,
  env.steps.migrate.stderr || env.steps.seed.stderr || env.steps.fixtures.stderr || env.serverLog());

const { one, all, db, as, client } = env;
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const linkPath = (body) => (body.match(/https?:\/\/[^\s/]+(\/(?:reset-password|verify-email)\/[A-Za-z0-9_-]+)/) || [])[1];
const mailTo = (to, template) => one("SELECT * FROM mail_outbox WHERE to_email = ? AND template = ? ORDER BY id DESC LIMIT 1", [to, template]);
const mailCount = async (to) => Number((await one("SELECT COUNT(*) n FROM mail_outbox WHERE to_email = ?", [to])).n);
const auditRow = (action) => one("SELECT * FROM crm_audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1", [action]);
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "");

try {
  // ---------------------------------------------------------------- schema
  const t = await all("SELECT table_name n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('password_reset_tokens','mail_outbox')", [DB]);
  const applied = await one("SELECT COUNT(*) n FROM migrations");
  check("MIG-P2", "Migration 113 added exactly the two new tables (password_reset_tokens, mail_outbox)", t.length === 2 && Number(applied.n) >= 13);

  const users = Object.fromEntries((await all("SELECT id, email, role, team_id, email_verified_at FROM crm_users")).map((u) => [u.email, u]));
  const demoUnverified = await one("SELECT COUNT(*) n FROM crm_users WHERE is_demo = 1 AND email_verified_at IS NULL");
  const demoPending = await one("SELECT COUNT(*) n FROM customer_accounts WHERE status <> 'active'");
  check("SEED-P2", "All 7 demo logins are created verified and active", Number(demoUnverified.n) === 0 && Number(demoPending.n) === 0);
  const loginPage = await client().get("/login");
  const boxEmails = [...loginPage.body.matchAll(/data-email="([^"]+)"/g)].map((m) => m[1]);
  check("LOGIN-P2", "Login page still lists exactly the 7 demo accounts", boxEmails.length === 7 && !boxEmails.some((e) => /joseph|ramon|patricia|edwin|fixture/.test(e)), boxEmails.join(", "));

  // ---------------------------------------------------------------- forgot password
  const guest = client();
  await guest.get("/forgot-password");
  const unknown = await guest.post("/forgot-password", { email: "nobody.here@example.test" });
  const known = await guest.post("/forgot-password", { email: "fixture.customer@example.test" });
  const norm = (r, email) => r.body.split(email).join("EMAIL").replace(/name="_csrf" value="[a-f0-9]+"/g, "");
  check("RESET-01", "Forgot password gives the same answer for unknown and known emails (no account enumeration)",
    unknown.status === 200 && known.status === 200 && norm(unknown, "nobody.here@example.test") === norm(known, "fixture.customer@example.test"));
  check("RESET-02", "A message is queued only for the real account", (await mailCount("nobody.here@example.test")) === 0 && (await mailCount("fixture.customer@example.test")) === 1);
  const resetMail = await mailTo("fixture.customer@example.test", "reset_password");
  const link1 = linkPath(resetMail.body_text);
  const raw1 = link1.split("/").pop();
  const tok = await one("SELECT token_hash, expires_at, used_at FROM password_reset_tokens ORDER BY id DESC LIMIT 1");
  const rawStored = await one("SELECT COUNT(*) n FROM password_reset_tokens WHERE token_hash = ?", [raw1]);
  check("RESET-03", "Only the SHA-256 of the token is stored (raw token is not in the table); link expires in about an hour",
    tok.token_hash === sha256(raw1) && Number(rawStored.n) === 0 && /^[a-f0-9]{64}$/.test(tok.token_hash) && (new Date(tok.expires_at) - Date.now()) < 61 * 60000 && (new Date(tok.expires_at) - Date.now()) > 50 * 60000);

  await guest.post("/forgot-password", { email: "fixture.customer@example.test" });
  const link2 = linkPath((await mailTo("fixture.customer@example.test", "reset_password")).body_text);
  const old = await guest.get(link1);
  check("RESET-04", "Asking again cancels the older link", link1 !== link2 && old.status === 410);

  const sessionA = await as("fixture.customer@example.test");
  check("RESET-05a", "Fixture customer is signed in on another device", (await sessionA.get("/portal")).status === 200);
  const form = await guest.get(link2);
  check("RESET-05b", "Valid link shows the new-password form", form.status === 200 && form.body.includes('name="confirm_password"'));
  const mismatch = await guest.post(link2, { password: "Another#1234", confirm_password: "different" });
  const tooShort = await guest.post(link2, { password: "short", confirm_password: "short" });
  check("RESET-06", "Mismatching or short passwords are rejected and the link stays usable", mismatch.status === 422 && tooShort.status === 422 && (await guest.get(link2)).status === 200);
  const done = await guest.post(link2, { password: "Another#1234", confirm_password: "Another#1234" });
  check("RESET-07", "A valid new password is saved and the user is sent to sign in", done.status === 302 && done.location === "/login");
  const oldPw = await client().login("fixture.customer@example.test", PASSWORD);
  const newPw = await client().login("fixture.customer@example.test", "Another#1234");
  check("RESET-08", "Old password stops working; the new one signs in", oldPw.status === 401 && newPw.status === 302 && newPw.location === "/portal");
  const reuse = await guest.post(link2, { password: "Third#12345", confirm_password: "Third#12345" });
  check("RESET-09", "A used link cannot be used again", reuse.status === 410);
  const afterReset = await sessionA.get("/portal");
  check("RESET-10", "The other signed-in session ends after the password change", afterReset.status === 302 && afterReset.location === "/login");
  const a1 = await auditRow("password_reset_completed");
  check("RESET-11", "Reset request and completion are audited", a1 && (await auditRow("password_reset_requested")));

  await guest.post("/forgot-password", { email: "fixture.customer@example.test" });
  await db.query("UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE used_at IS NULL");
  const expiredLink = linkPath((await mailTo("fixture.customer@example.test", "reset_password")).body_text);
  const expired = await guest.get(expiredLink);
  const garbage = await guest.get("/reset-password/not-a-real-token-at-all-0000");
  check("RESET-12", "Expired and made-up links are refused", expired.status === 410 && garbage.status === 410);

  const edwinBefore = await mailCount("edwin.sarmiento@johnvivz.test");
  const edwinResp = await guest.post("/forgot-password", { email: "edwin.sarmiento@johnvivz.test" });
  check("RESET-13", "No link is sent to a staff login that HR has separated (same neutral answer)", edwinResp.status === 200 && (await mailCount("edwin.sarmiento@johnvivz.test")) === edwinBefore);

  await guest.post("/forgot-password", { email: "ramon.aquino@johnvivz.test" });
  const ramonLink = linkPath((await mailTo("ramon.aquino@johnvivz.test", "reset_password")).body_text);
  await guest.post(ramonLink, { password: "Ramon#12345", confirm_password: "Ramon#12345" });
  const ramonLogin = await client().login("ramon.aquino@johnvivz.test", "Ramon#12345");
  check("RESET-14", "Staff reset their password by email too", ramonLogin.status === 302 && ramonLogin.location === "/crm/agent");

  // password change inside the app keeps this session and ends the others
  const pA = await as("patricia.lim@johnvivz.test");
  const pB = await as("patricia.lim@johnvivz.test");
  await pA.get("/profile");
  await pA.post("/profile/password", { current_password: PASSWORD, password: "Patricia#123", confirm_password: "Patricia#123" });
  const pAfterA = await pA.get("/crm/agent");
  const pAfterB = await pB.get("/crm/agent");
  check("RESET-15", "Changing the password in the profile keeps this session and ends the other one", pAfterA.status === 200 && pAfterB.status === 302 && pAfterB.location === "/login");

  // ---------------------------------------------------------------- email verification
  const reg = client();
  const regForm = { first_name: "Vera", last_name: "Verify", email: "vera.verify@example.test", mobile: "0917 000 2222", address: "Calapan", password: "Secret@123", confirm_password: "Secret@123", consent: "1" };
  await reg.get("/register");
  const regResp = await reg.post("/register", regForm);
  const vera = await one("SELECT u.id, u.email_verified_at, ca.status FROM crm_users u JOIN customer_accounts ca ON ca.user_id = u.id WHERE u.email = ?", ["vera.verify@example.test"]);
  const verifyMail = await mailTo("vera.verify@example.test", "verify_email");
  const verifyPath = verifyMail && linkPath(verifyMail.body_text);
  check("VERIFY-01", "Registration creates a pending account, sends a verification email and does not sign the customer in",
    regResp.status === 200 && vera && vera.email_verified_at === null && vera.status === "pending_verification" && verifyPath && regResp.body.includes(verifyPath) && (await reg.get("/portal")).status === 302,
    `${regResp.status} ${JSON.stringify(vera)}`);
  const early = await client().login("vera.verify@example.test", "Secret@123");
  check("VERIFY-02", "Sign-in is refused until the email is confirmed, with a way to request a new link", early.status === 403 && /confirm your email/i.test(early.body) && early.body.includes("/verify-email/resend"), `${early.status}`);
  const peek = await reg.get(verifyPath);
  const stillPending = await one("SELECT status FROM customer_accounts WHERE user_id = ?", [vera.id]);
  check("VERIFY-03", "Opening the link only shows a confirm button (a mail scanner cannot verify by fetching it)", peek.status === 200 && peek.body.includes("Confirm email") && stillPending.status === "pending_verification");
  const resend = await client();
  await resend.get("/login");
  await resend.post("/verify-email/resend", { email: "vera.verify@example.test" });
  const newVerifyPath = linkPath((await mailTo("vera.verify@example.test", "verify_email")).body_text);
  const staleLink = await reg.get(verifyPath);
  check("VERIFY-04", "Resending sends a new link and cancels the old one", newVerifyPath !== verifyPath && staleLink.status === 410);
  const noMailBefore = await mailCount("juan.cruz@johnvivz.test");
  const resendActive = await resend.post("/verify-email/resend", { email: "juan.cruz@johnvivz.test" });
  const resendUnknown = await resend.post("/verify-email/resend", { email: "ghost@example.test" });
  check("VERIFY-05", "Resend sends nothing for active or unknown addresses and answers identically", resendActive.status === 200 && resendUnknown.status === 200 && (await mailCount("juan.cruz@johnvivz.test")) === noMailBefore && (await mailCount("ghost@example.test")) === 0);
  const confirm = await reg.post(newVerifyPath, {});
  const verified = await one("SELECT u.email_verified_at, ca.status FROM crm_users u JOIN customer_accounts ca ON ca.user_id = u.id WHERE u.id = ?", [vera.id]);
  check("VERIFY-06", "Confirming activates the account and records the verification time", confirm.status === 200 && verified.status === "active" && verified.email_verified_at !== null);
  const veraLogin = await client().login("vera.verify@example.test", "Secret@123");
  check("VERIFY-07", "After confirmation the customer signs in to the portal", veraLogin.status === 302 && veraLogin.location === "/portal");
  const again = await reg.post(newVerifyPath, {});
  check("VERIFY-08", "A used verification link cannot be used again", again.status === 410);
  const vAudit = await auditRow("email_verified");
  check("VERIFY-09", "Registration, link sending and verification are audited", vAudit && (await auditRow("customer_registered")) && (await auditRow("verification_email_queued")));

  // a reset link also proves the mailbox, so it activates a pending customer
  const reg2 = client();
  await reg2.get("/register");
  await reg2.post("/register", { ...regForm, email: "pending.reset@example.test", first_name: "Pen", last_name: "Ding" });
  await reg2.get("/forgot-password");
  await reg2.post("/forgot-password", { email: "pending.reset@example.test" });
  const pr = linkPath((await mailTo("pending.reset@example.test", "reset_password")).body_text);
  await reg2.post(pr, { password: "Pending#1234", confirm_password: "Pending#1234" });
  const pend = await one("SELECT u.email_verified_at, ca.status FROM crm_users u JOIN customer_accounts ca ON ca.user_id = u.id WHERE u.email = 'pending.reset@example.test'");
  check("VERIFY-10", "Setting a password from the emailed link also confirms the email and activates the account", pend.status === "active" && pend.email_verified_at !== null);
  const reg3 = client();
  await reg3.get("/register");
  const r3 = await reg3.post("/register", { ...regForm, email: "late.verify@example.test", first_name: "Late", last_name: "Verify" });
  const latePath = linkPath((await mailTo("late.verify@example.test", "verify_email")).body_text);
  await db.query("UPDATE email_verification_tokens SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE used_at IS NULL");
  const lateTry = await reg3.post(latePath, {});
  check("VERIFY-11", "An expired verification link is refused", r3.status === 200 && lateTry.status === 410);

  // ---------------------------------------------------------------- Teams & CRM Access: who may open it
  const mgr = await as("manager@johnvivz.test");
  const tl = await as("maria.santos@johnvivz.test");
  const agent = await as("kristine.bautista@johnvivz.test");
  const cust = await as("juan.cruz@johnvivz.test");
  const setup = await as("admin@johnvivz.test");
  const ACCESS = "/crm/settings/access";
  const open = {};
  for (const [name, c] of Object.entries({ manager: mgr, teamLeader: tl, agent, customer: cust, setup })) open[name] = (await c.get(ACCESS)).status;
  const guestAccess = await client().get(ACCESS);
  check("ACCESS-01", "Only the CRM Manager opens Teams & CRM Access (others 403, visitors sent to sign in)",
    open.manager === 200 && open.teamLeader === 403 && open.agent === 403 && open.customer === 403 && open.setup === 403 && guestAccess.status === 302 && guestAccess.location === "/login", JSON.stringify(open));
  await tl.get("/crm/team-leader");
  await agent.get("/crm/agent");
  const forgedGrant = await tl.post(`${ACCESS}/provision`, {}); // a Manager-only action (the old /grant route no longer exists)
  const forgedAgent = await agent.post(`${ACCESS}/users/${users["manager@johnvivz.test"].id}/access`, { active: "0", reason: "forged request" });
  const deniedRows = await one("SELECT COUNT(*) n FROM crm_audit_logs WHERE action = 'access_denied' AND details LIKE '%/crm/settings/access%'");
  check("ACCESS-02", "Forged POSTs by a Team Leader and an Agent are refused (403) and audited", forgedGrant.status === 403 && forgedAgent.status === 403 && Number(deniedRows.n) >= 3, `${forgedGrant.status}/${forgedAgent.status}/${deniedRows.n}`);

  // extra HR employees without a CRM login (mock fixture rows)
  const emp = (id, name, email, status) => db.query(
    `INSERT INTO employee_references (employee_id, full_name, work_email, department_id, position_id, employment_status, supervisor_employee_id, source, source_version, is_mock, last_synced_at)
     VALUES (?, ?, ?, 'MOCK-DEP-CRM', 'MOCK-POS-CRM-AGT', ?, 'MOCK-EMP-1002', 'johnvivz_hr (mock)', 'test-fixture', 1, NOW())`, [id, name, email, status]);
  await emp("MOCK-EMP-T006", "Carlo Mendoza", "carlo.mendoza@johnvivz.test", "active");
  await emp("MOCK-EMP-T007", "Dina Flores", "dina.flores@johnvivz.test", "on_leave");
  await emp("MOCK-EMP-T008", "Hector Ramos", "hector.ramos@johnvivz.test", "separated");
  await emp("MOCK-EMP-T009", "Noemi Santos", null, "active");
  const team1 = users["kristine.bautista@johnvivz.test"].team_id;
  const team2 = env.fix.team2;
  const alertsOf = (html) => [...html.matchAll(/role="(?:alert|status)">.*?<span>([^<]*)<\/span>/gs)].map((m) => m[1].replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&"));
  const page = await mgr.get(ACCESS);
  check("ACCESS-03", "The screen lists the CRM department's HR employees read-only (mock badge, HR status, account state) and offers no field to edit HR data; the old Grant CRM access form is gone",
    page.status === 200 && page.body.includes("Carlo Mendoza") && page.body.includes("Mock HR") && !/name="(full_name|work_email|employment_status|position_id)"/.test(page.body) && !page.body.includes("Grant CRM access") && page.body.includes("Create accounts from HR now") && page.body.includes("No CRM account"));

  // ---------------------------------------------------------------- staff accounts from HR (employee account flow, contract §12.5)
  const hrBefore = await all("SELECT employee_id, full_name, work_email, employment_status, position_id FROM employee_references ORDER BY employee_id");
  const loginsBefore = await all("SELECT id, employee_id, role, team_id, is_active, password_hash FROM crm_users WHERE employee_id IS NOT NULL ORDER BY id");
  await mgr.get(ACCESS);
  await mgr.post(`${ACCESS}/provision`, {});
  const provFlash = alertsOf((await mgr.get(ACCESS)).body).join(" | ");
  const acct = (id) => one("SELECT * FROM crm_users WHERE employee_id = ?", [id]);
  const carloNew = await acct("MOCK-EMP-T006");
  const dinaNew = await acct("MOCK-EMP-T007");
  check("GRANT-01", "Create accounts from HR: an active and an on-leave CRM-department employee each get a SWITCHED-OFF staff account with NO password (login via ESS, role Agent from the position rule \"CRM Agent\", no team); a separated employee and one without an email get none",
    carloNew && dinaNew && [carloNew, dinaNew].every((u) => u.user_type === "staff" && u.role === "agent" && u.role_source === "position_rule" && u.login_via === "ess" && u.password_hash === null && u.is_active === 0 && u.team_id === null && u.ess_activated_at === null)
    && !(await acct("MOCK-EMP-T008")) && !(await acct("MOCK-EMP-T009")) && /staff account\(s\) created \(Waiting for ESS registration\)/.test(provFlash), `${provFlash} ${JSON.stringify(carloNew)}`);
  const loginsAfter = await all("SELECT id, employee_id, role, team_id, is_active, password_hash FROM crm_users WHERE employee_id IS NOT NULL AND id IN (?) ORDER BY id", [loginsBefore.map((r) => r.id)]);
  const hrAfter = await all("SELECT employee_id, full_name, work_email, employment_status, position_id FROM employee_references ORDER BY employee_id");
  const provAudit = await auditRow("staff_account_created_from_hr");
  check("GRANT-02", "Existing logins are untouched, HR data is never edited, and each created account is audited (role, position, 'Waiting for ESS registration')",
    JSON.stringify(loginsAfter) === JSON.stringify(loginsBefore) && JSON.stringify(hrAfter) === JSON.stringify(hrBefore) && provAudit && JSON.stringify(provAudit.after_values).includes("Waiting for ESS registration"));
  const page2 = await mgr.get(ACCESS);
  const grantGone = await mgr.post(`${ACCESS}/grant`, { employee_id: "MOCK-EMP-T006", role: "agent", team_id: String(team1) });
  const inviteGone = await mgr.post(`${ACCESS}/users/${carloNew.id}/invite`, {});
  check("GRANT-03", "The page shows the state 'Waiting for ESS registration'; the old grant and invitation actions no longer exist (404)",
    /data-employee="MOCK-EMP-T006" data-state="waiting"/.test(page2.body) && page2.body.includes("Waiting for ESS registration") && grantGone.status === 404 && inviteGone.status === 404, `${grantGone.status} ${inviteGone.status}`);
  const before1 = await client().login("carlo.mendoza@johnvivz.test", PASSWORD);
  const enableTry = await mgr.post(`${ACCESS}/users/${carloNew.id}/access`, { active: "1", reason: "Try to switch it on by hand" });
  check("GRANT-04", "Before ESS registration nobody can sign in to the new account (one generic message), and the Manager cannot switch it on by hand",
    before1.status === 401 && (await acct("MOCK-EMP-T006")).is_active === 0 && enableTry.status === 302, `${before1.status}`);
  await setup.get("/setup/staff");
  const badReg = await setup.post("/setup/staff/mock-ess", { email: "nobody@johnvivz.test", password: "Carlo#12345" });
  const regFlash = alertsOf((await setup.get("/setup/staff")).body).join(" | ");
  await setup.post("/setup/staff/mock-ess", { email: "carlo.mendoza@johnvivz.test", password: "Carlo#12345" });
  await mgr.get(ACCESS);
  await mgr.post(`${ACCESS}/users/${carloNew.id}/assignment`, { role: "agent", team_id: String(team1), reason: "First team for the new hire" });
  const carloLogin = await client().login("carlo.mendoza@johnvivz.test", "Carlo#12345");
  const carloLive = await acct("MOCK-EMP-T006");
  check("GRANT-05", "The new hire registers in (mock) ESS, the Manager sets the team, and the first sign-in with the ESS password activates the account and opens the agent dashboard; CRM still stores no password",
    badReg.status === 302 && /No HR employee has this email/.test(regFlash) && carloLogin.status === 302 && carloLogin.location === "/crm/agent" && carloLive.is_active === 1 && carloLive.ess_activated_at !== null && carloLive.password_hash === null && carloLive.team_id === team1, `${regFlash} ${carloLogin.status} ${carloLogin.location}`);
  const actAudit = await auditRow("staff_activated_via_ess");
  const wrongPw = await client().login("carlo.mendoza@johnvivz.test", "Wrong#12345");
  check("GRANT-06", "Activation is audited ('activated via ESS'); a wrong ESS password gets the same generic message and is audited", actAudit && /activated via ESS/.test(actAudit.details) && wrongPw.status === 401 && wrongPw.body.includes("We could not sign you in") && (await auditRow("login_failed")));
  // position rules and the Manager's override
  await mgr.get(ACCESS);
  await mgr.post(`${ACCESS}/rules`, { department_code: "CRM", contains_0: "Manager", role_0: "crm_manager", contains_1: "Team Leader", role_1: "team_leader", contains_2: "CRM Agent", role_2: "team_leader" });
  await mgr.post(`${ACCESS}/provision`, {});
  const dinaRule = (await acct("MOCK-EMP-T007")).role;
  const carloRule = (await acct("MOCK-EMP-T006")).role;
  await mgr.post(`${ACCESS}/users/${dinaNew.id}/assignment`, { role: "agent", team_id: String(team2), reason: "Starts as an agent in team two" });
  await mgr.post(`${ACCESS}/provision`, {});
  const dinaKept = await acct("MOCK-EMP-T007");
  await mgr.post(`${ACCESS}/rules`, { department_code: "CRM", contains_0: "Manager", role_0: "crm_manager", contains_1: "Team Leader", role_1: "team_leader" });
  await mgr.post(`${ACCESS}/provision`, {});
  check("GRANT-07", "Position rules (Manager › Settings) decide the role: a changed rule updates accounts whose role was not set by hand (audited); a role the Manager set by hand is kept",
    dinaRule === "team_leader" && carloRule === "team_leader" && dinaKept.role === "agent" && dinaKept.role_source === "manager" && dinaKept.team_id === team2 && (await acct("MOCK-EMP-T006")).role === "agent"
    && (await auditRow("staff_role_from_position")) && (await auditRow("staff_account_rules_changed")), `${dinaRule} ${carloRule} ${JSON.stringify(dinaKept)}`);
  const forgot = client();
  await forgot.get("/forgot-password");
  const mailsCarlo = await mailCount("carlo.mendoza@johnvivz.test");
  const fp = await forgot.post("/forgot-password", { email: "carlo.mendoza@johnvivz.test" });
  check("GRANT-08", "Staff 'Forgot password' points to ESS: the page says so, and no CRM reset link is sent to an ESS account", fp.body.includes("reset it, use ESS") && (await mailCount("carlo.mendoza@johnvivz.test")) === mailsCarlo);
  const carlo = carloLive;
  const unitRules = env.node(["--input-type=module", "-e", "const { matchPosition, DEFAULT_ROLE_RULES: R } = await import('./services/staffAccountService.js'); console.log('RULES ' + JSON.stringify(['CRM Manager', ' crm  manager', 'Team Leader', 'Customer Service Agent', 'Assistant Store Manager', 'CRM Team Leader', 'Cashier'].map((t) => { const m = matchPosition(t, R); return [m.role, m.review, m.rule ? m.rule.match : null]; })));"]);
  const rules9 = JSON.parse((unitRules.stdout.match(/RULES (.*)/) || [])[1] || "[]");
  check("GRANT-09", "Default position rules (team decision): exact titles first (CRM Manager, Team Leader, Customer Service Agent), 'contains Manager' only as a fallback; a title that matches nothing is Agent and flagged for review",
    JSON.stringify(rules9) === JSON.stringify([["crm_manager", false, "exact"], ["crm_manager", false, "exact"], ["team_leader", false, "exact"], ["agent", false, "exact"], ["crm_manager", false, "contains"], ["agent", true, null], ["agent", true, null]])
    && /data-employee="MOCK-EMP-T006"[\s\S]*?data-needs-review="1"/.test(page2.body) && /data-review-count="\d+"/.test(page2.body), unitRules.stdout + unitRules.stderr.slice(0, 300));
  await mgr.get(ACCESS);
  await mgr.post(`${ACCESS}/rules`, { department_code: "CRM", match_0: "exact", text_0: "CRM Manager", role_0: "crm_manager", match_1: "exact", text_1: "Team Leader", role_1: "team_leader", match_2: "exact", text_2: "CRM Agent", role_2: "agent", match_3: "contains", text_3: "Manager", role_3: "crm_manager" });
  const page10 = (await mgr.get(ACCESS)).body;
  const stored10 = JSON.parse((await one("SELECT setting_value FROM crm_settings WHERE setting_key = 'staff.position_role_rules'")).setting_value);
  check("GRANT-10", "The Manager saves exact-title and contains rules; once 'CRM Agent' is an exact rule, the people with that title are no longer flagged for review",
    stored10.length === 4 && stored10[2].match === "exact" && stored10[2].text === "CRM Agent" && stored10[3].match === "contains" && page10.includes('data-employee="MOCK-EMP-T006"') && !(page10.split('data-employee="MOCK-EMP-T006"')[1] || "").split("</tr>")[0].includes("data-needs-review"), JSON.stringify(stored10));
  void hrBefore;

  // ---------------------------------------------------------------- teams
  await mgr.get(ACCESS);
  await mgr.post(`${ACCESS}/teams`, { name: "Returns Desk Team" });
  await mgr.post(`${ACCESS}/teams`, { name: "Returns Desk Team" });
  const newTeam = await one("SELECT * FROM crm_teams WHERE name = 'Returns Desk Team'");
  const teamCount = await one("SELECT COUNT(*) n FROM crm_teams WHERE name = 'Returns Desk Team'");
  check("TEAM-01", "A team can be created (next code, active); a duplicate name is refused", newTeam && /^TEAM-\d+$/.test(newTeam.team_code) && newTeam.is_active === 1 && Number(teamCount.n) === 1 && (await auditRow("team_created")));
  await mgr.post(`${ACCESS}/teams/${newTeam.id}`, { name: "Returns & Refunds Team", team_leader_id: "" });
  const renamed = await one("SELECT name FROM crm_teams WHERE id = ?", [newTeam.id]);
  const renameAudit = await auditRow("team_renamed");
  check("TEAM-02", "Renaming a team is audited with before and after", renamed.name === "Returns & Refunds Team" && renameAudit.before_values?.name === "Returns Desk Team" && renameAudit.after_values?.name === "Returns & Refunds Team");
  await mgr.post(`${ACCESS}/teams/${newTeam.id}`, { team_leader_id: String(users["kristine.bautista@johnvivz.test"].id) });
  const wrongLeader = await one("SELECT team_leader_id FROM crm_teams WHERE id = ?", [newTeam.id]);
  check("TEAM-03", "Only an active Team Leader of that team can be set as its leader", wrongLeader.team_leader_id === null);
  await mgr.post(`${ACCESS}/teams/${team1}/toggle`, { active: "0" });
  const stillActive = await one("SELECT is_active FROM crm_teams WHERE id = ?", [team1]);
  check("TEAM-04", "A team with active members cannot be deactivated", stillActive.is_active === 1);

  // ---------------------------------------------------------------- change role / team
  const carlo2 = await one("SELECT id FROM crm_users WHERE employee_id = 'MOCK-EMP-T006'");
  const k = users["kristine.bautista@johnvivz.test"];
  await mgr.post(`${ACCESS}/users/${k.id}/assignment`, { role: "agent", team_id: String(team2), reason: "Test move with active cases" });
  const kAfter = await one("SELECT team_id FROM crm_users WHERE id = ?", [k.id]);
  const kPage = await mgr.get(ACCESS);
  check("CHANGE-01", "Moving a person who still has active cases is refused with the reason shown", kAfter.team_id === team1 && /still has \d+ active case/.test(kPage.body));
  await mgr.post(`${ACCESS}/users/${carlo2.id}/assignment`, { role: "team_leader", team_id: String(team1), reason: "Test promotion" });
  const noPromo = await one("SELECT role FROM crm_users WHERE id = ?", [carlo2.id]);
  await mgr.post(`${ACCESS}/users/${carlo2.id}/assignment`, { role: "team_leader", team_id: String(newTeam.id), reason: "" });
  const noReason = await one("SELECT role FROM crm_users WHERE id = ?", [carlo2.id]);
  check("CHANGE-02", "A second Team Leader in the same team and a change without a reason are both refused", noPromo.role === "agent" && noReason.role === "agent");
  await mgr.post(`${ACCESS}/users/${carlo2.id}/assignment`, { role: "team_leader", team_id: String(newTeam.id), reason: "Opens the new Returns desk" });
  const promoted = await one("SELECT u.role, u.team_id, t.team_leader_id FROM crm_users u JOIN crm_teams t ON t.id = u.team_id WHERE u.id = ?", [carlo2.id]);
  const changeAudit = await auditRow("crm_access_changed");
  check("CHANGE-03", "Promoting to Team Leader of another team works, sets the team's leader and is audited (reason, before/after)",
    promoted.role === "team_leader" && promoted.team_id === newTeam.id && promoted.team_leader_id === carlo2.id && changeAudit.reason === "Opens the new Returns desk" && changeAudit.before_values?.role === "agent" && changeAudit.after_values?.role === "team_leader");
  const carloTl = await as("carlo.mendoza@johnvivz.test", "Carlo#12345");
  const carloHome = await carloTl.get("/crm/team-leader");
  check("CHANGE-04", "The new role takes effect on the person's next request", carloHome.status === 200);
  await mgr.post(`${ACCESS}/users/${carlo2.id}/assignment`, { role: "agent", team_id: String(team1), reason: "Back to Customer Care" });
  const demoted = await one("SELECT u.role, (SELECT COUNT(*) FROM crm_teams WHERE team_leader_id = u.id) leads FROM crm_users u WHERE u.id = ?", [carlo2.id]);
  check("CHANGE-05", "Moving a Team Leader away clears their team's leader", demoted.role === "agent" && Number(demoted.leads) === 0);
  await mgr.post(`${ACCESS}/teams/${newTeam.id}/toggle`, { active: "0" });
  const off = await one("SELECT is_active FROM crm_teams WHERE id = ?", [newTeam.id]);
  await mgr.post(`${ACCESS}/teams/${newTeam.id}/toggle`, { active: "1" });
  const on = await one("SELECT is_active FROM crm_teams WHERE id = ?", [newTeam.id]);
  check("TEAM-05", "An empty team can be deactivated and reactivated (audited)", off.is_active === 0 && on.is_active === 1 && (await auditRow("team_reactivated")) && (await auditRow("team_deactivated")));

  // ---------------------------------------------------------------- switch access off / on
  const ramon = users["ramon.aquino@johnvivz.test"];
  const ramonSession = await as("ramon.aquino@johnvivz.test", "Ramon#12345");
  check("OFF-00", "Ramon is signed in before access is switched off", (await ramonSession.get("/crm/agent")).status === 200);
  await mgr.post(`${ACCESS}/users/${ramon.id}/access`, { active: "0", reason: "" });
  check("OFF-01", "Switching access off needs a reason", (await one("SELECT is_active FROM crm_users WHERE id = ?", [ramon.id])).is_active === 1);
  await mgr.post(`${ACCESS}/users/${ramon.id}/access`, { active: "0", reason: "On leave without HR record, pending review" });
  const ramonNext = await ramonSession.get("/crm/agent");
  const ramonRelogin = await client().login("ramon.aquino@johnvivz.test", "Ramon#12345");
  const offAudit = await auditRow("crm_access_disabled");
  check("OFF-02", "Switching access off ends the open session and blocks sign-in; the reason and before/after are audited",
    ramonNext.status === 302 && ramonRelogin.status === 403 && offAudit.reason === "On leave without HR record, pending review" && offAudit.before_values?.is_active === true && offAudit.after_values?.is_active === false, `${ramonNext.status}/${ramonRelogin.status}`);
  await mgr.post(`${ACCESS}/users/${ramon.id}/access`, { active: "1", reason: "Review finished, access restored" });
  const ramonBack = await client().login("ramon.aquino@johnvivz.test", "Ramon#12345");
  check("OFF-03", "Switching access back on restores sign-in", ramonBack.status === 302);
  const edwin = users["edwin.sarmiento@johnvivz.test"];
  await mgr.post(`${ACCESS}/users/${edwin.id}/access`, { active: "0", reason: "Test: switch off a separated person" });
  await mgr.post(`${ACCESS}/users/${edwin.id}/access`, { active: "1", reason: "Test: switch back on" });
  const edwinFlash = await mgr.get(ACCESS);
  const edwinLogin = await client().login("edwin.sarmiento@johnvivz.test");
  check("OFF-04", "Re-enabling never lifts an HR block: a separated employee still cannot sign in, and the screen says so", edwinLogin.status === 403 && edwinFlash.body.includes("HR still blocks"));
  const self = users["manager@johnvivz.test"];
  await mgr.post(`${ACCESS}/users/${self.id}/access`, { active: "0", reason: "Test: try to lock myself out" });
  await mgr.post(`${ACCESS}/users/${self.id}/assignment`, { role: "agent", team_id: String(team1), reason: "Test: try to demote myself" });
  const selfRow = await one("SELECT role, is_active FROM crm_users WHERE id = ?", [self.id]);
  check("OFF-05", "The Manager cannot switch off or demote their own login", selfRow.role === "crm_manager" && selfRow.is_active === 1);
  const fpClient = client();
  await fpClient.get("/forgot-password");
  const mailsBefore = await mailCount("ramon.aquino@johnvivz.test");
  await fpClient.post("/forgot-password", { email: "ramon.aquino@johnvivz.test" });
  const linkAfter = await mailCount("ramon.aquino@johnvivz.test");
  await mgr.post(`${ACCESS}/users/${ramon.id}/access`, { active: "0", reason: "Test: switch off before a reset" });
  await fpClient.get("/forgot-password");
  await fpClient.post("/forgot-password", { email: "ramon.aquino@johnvivz.test" });
  const linkOff = await mailCount("ramon.aquino@johnvivz.test");
  await mgr.post(`${ACCESS}/users/${ramon.id}/access`, { active: "1", reason: "Test: switch back on" });
  const mgrInvite = await mgr.post(`${ACCESS}/users/${ramon.id}/invite`, {});
  check("OFF-06", "A local staff login (fixture, mock ESS) still gets a reset link from Forgot password only while active; the Manager no longer sends invitations or links (404)", linkAfter === mailsBefore + 1 && linkOff === linkAfter && mgrInvite.status === 404, `${mailsBefore} ${linkAfter} ${linkOff} ${mgrInvite.status}`);

  // ---------------------------------------------------------------- TC-06: HR reference updates (mock mode)
  await db.query("UPDATE department_references SET last_synced_at = '2020-01-01 00:00:00' WHERE department_id = 'MOCK-DEP-CRM'");
  await db.query("UPDATE position_references SET last_synced_at = '2020-01-01 00:00:00' WHERE position_id = 'MOCK-POS-CRM-AGT'");
  await setup.get("/setup/staff");
  const depResp = await setup.post("/setup/staff/hr-reference", { reference_id: "department:MOCK-DEP-CRM", label: "CRM / Customer Care (mock)" });
  const posResp = await setup.post("/setup/staff/hr-reference", { reference_id: "position:MOCK-POS-CRM-AGT", label: "Customer Care Agent" });
  const dep = await one("SELECT name, last_synced_at FROM department_references WHERE department_id = 'MOCK-DEP-CRM'");
  const pos = await one("SELECT title, last_synced_at FROM position_references WHERE position_id = 'MOCK-POS-CRM-AGT'");
  const fresh = (d) => Date.now() - new Date(d).getTime() < 5 * 60000;
  const hrAudit = await auditRow("hr_reference_updated");
  check("TC-06", "DepartmentUpdated / PositionUpdated update the CRM copy and refresh last_synced_at (mock mode); the change is audited with before/after",
    depResp.status === 302 && posResp.status === 302 && dep.name === "CRM / Customer Care (mock)" && pos.title === "Customer Care Agent" && fresh(dep.last_synced_at) && fresh(pos.last_synced_at) && hrAudit.before_values && hrAudit.after_values);
  const shown = await mgr.get(ACCESS);
  check("TC-06b", "The Manager's screen shows the updated HR names read-only", shown.body.includes("Customer Care Agent") && shown.body.includes("CRM / Customer Care (mock)"));
  const editTry = await mgr.post(`${ACCESS}/employees/MOCK-EMP-1002`, { full_name: "Changed" });
  const mgrSim = await mgr.post("/setup/staff/hr-reference", { reference_id: "department:MOCK-DEP-CRM", label: "Hijack" });
  const depAfter = await one("SELECT name FROM department_references WHERE department_id = 'MOCK-DEP-CRM'");
  check("TC-06c", "CRM users cannot edit HR references: no edit route exists and the simulator is for the setup account only", editTry.status === 404 && mgrSim.status === 403 && depAfter.name === "CRM / Customer Care (mock)", `${editTry.status}/${mgrSim.status}`);
  const badRef = await setup.post("/setup/staff/hr-reference", { reference_id: "department:NOPE", label: "x y" });
  const badRefPage = await setup.get("/setup/staff");
  check("TC-06d", "An event for an unknown reference is rejected with a message", badRef.status === 302 && badRefPage.body.includes("is not in department_references"));

  // ---------------------------------------------------------------- Mail Log (setup only)
  const mailPage = await setup.get("/setup/mail-log");
  const mailMgr = await mgr.get("/setup/mail-log");
  check("MAIL-01", "Setup > Mail Log lists the queued emails (development mailbox); the Manager cannot open it", mailPage.status === 200 && mailPage.body.includes("Reset your JOHNVIVZ password") && mailPage.body.includes("logged only") && mailMgr.status === 403);

  // ---------------------------------------------------------------- per-role page check
  const BAD = /\[object Object\]|\bundefined\b|\bNaN\b|\{\{|\}\}/;
  const pageProblems = [];
  const visit = async (label, c, paths, expected = 200) => {
    for (const p of paths) {
      const r = await c.get(p);
      const want = Array.isArray(expected) ? expected : [expected];
      if (!want.includes(r.status)) pageProblems.push(`${label} ${p} → ${r.status}`);
      else if (typeof r.body === "string" && r.status < 400 && BAD.test(strip(r.body))) pageProblems.push(`${label} ${p} → bad text`);
    }
  };
  const navLinks = async (c, home) => {
    const body = (await c.get(home)).body;
    const nav = body.split('aria-label="Main"')[1]?.split("</nav>")[0] || "";
    return [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  };
  const firstCase = async (c, list, prefix) => { const b = (await c.get(list)).body; const m = b.match(new RegExp(`href="(${prefix}/\\d+)"`)); return m ? [m[1]] : []; };

  const visitor = client();
  await visit("visitor", visitor, ["/", "/login", "/register", "/forgot-password"]);
  await visit("visitor", visitor, ["/reset-password/unknown-token-000000000", "/verify-email/unknown-token-000000000"], 410);
  await visit("visitor", visitor, ["/crm/manager", "/portal", "/setup", ACCESS, "/setup/mail-log"], 302);

  const roles = [
    ["manager", mgr, "/crm/manager", ["/profile", "/notifications", "/crm/settings", "/crm/settings/categories", "/crm/settings/templates", "/crm/settings/audit-logs", "/crm/settings/permissions", ACCESS, "/crm/reports", "/crm/team-performance"], ["/setup", "/setup/mail-log", "/setup/staff", "/portal"]],
    ["teamLeader", tl, "/crm/team-leader", ["/profile", "/notifications", "/crm/queue", "/crm/reports"], [ACCESS, "/crm/settings", "/setup", "/setup/mail-log", "/portal"]],
    ["agent", agent, "/crm/agent", ["/profile", "/notifications", "/crm/customers"], [ACCESS, "/crm/settings", "/crm/reports", "/setup", "/portal"]],
    ["customer", cust, "/portal", ["/notifications", "/portal/cases/new", "/portal/preferences"], ["/crm/manager", ACCESS, "/setup", "/crm/cases"]],
    ["setup", setup, "/setup", ["/profile", "/setup/settings", "/setup/categories", "/setup/templates", "/setup/staff", "/setup/mail-log", "/setup/audit-logs"], ["/crm/manager", ACCESS, "/crm/cases", "/portal", "/crm/settings"]],
  ];
  for (const [label, c, home, extra, forbidden] of roles) {
    const links = await navLinks(c, home);
    await visit(label, c, [home, ...links, ...extra]);
    const caseLink = label === "customer" ? await firstCase(c, "/portal/cases", "/portal/cases") : label === "setup" ? [] : await firstCase(c, "/crm/cases", "/crm/cases");
    await visit(label, c, caseLink);
    await visit(label, c, forbidden, [403, 404]);
  }
  check("PAGES-01", `Per-role page check: every menu link, settings tab and sample case page opens without errors or stray text; forbidden pages return 403 (checked ${roles.length} signed-in roles + visitor)`, pageProblems.length === 0, pageProblems.slice(0, 8).join("; "));

  // ---------------------------------------------------------------- rate limit on forgot-password
  const limiter = client();
  await limiter.get("/forgot-password");
  let limited = 0;
  for (let i = 0; i < 60 && !limited; i++) {
    const r = await limiter.post("/forgot-password", { email: `rate${i}@example.test` });
    if (r.status === 429) limited = i + 1;
  }
  check("RATE-01", "Forgot-password requests are rate limited (429 after the allowed number)", limited > 0, `limited after ${limited}`);
} finally {
  await env.stop();
}
summarize(DB);
