/*
 * Extra fixtures for tests/p1.acceptance.mjs. Runs against the throwaway test database only
 * (DB_NAME is set by the test runner). The demo seed has exactly one account per role, so the
 * scenarios that need more people create them here, flagged is_demo = 0 so they never appear in
 * the login page's "Demo accounts" box:
 *   - a second team (Orders & Delivery) with its own Team Leader and agent
 *   - a second agent in the first team (used for the HR "separated" scenario)
 *   - a separated HR employee who already has a revoked agent login
 *   - one customer with two cases: one routed to the first team, one to the second team
 * Prints the created ids as JSON on the last line.
 */
import bcrypt from "bcrypt";
import { sequelize, CrmUser, CrmTeam, CaseCategory } from "../../models/index.js";
import { createCase, assignCase } from "../../services/caseService.js";
import { registerPortalCustomer } from "../../services/customerService.js";
import { loadSettings } from "../../services/settingsService.js";

const dbName = process.env.DB_NAME || "";
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to create fixtures in "${dbName}": the database name must end with _test.`);
  process.exit(1);
}

try {
  await loadSettings();
  const hash = await bcrypt.hash("Demo@1234", 10);
  const out = {};

  const employee = (id, name, email, positionId, status, supervisor) => sequelize.query(
    `INSERT INTO employee_references (employee_id, full_name, work_email, department_id, position_id, employment_status,
                                      supervisor_employee_id, source, source_version, is_mock, last_synced_at)
     VALUES (:id, :name, :email, 'MOCK-DEP-CRM', :positionId, :status, :supervisor, 'johnvivz_hr (mock)', 'test-fixture', 1, NOW())`,
    { replacements: { id, name, email, positionId, status, supervisor } }
  );
  await employee("MOCK-EMP-T002", "Joseph Villanueva", "joseph.villanueva@johnvivz.test", "MOCK-POS-CRM-TL", "active", "MOCK-EMP-1001");
  await employee("MOCK-EMP-T003", "Ramon Aquino", "ramon.aquino@johnvivz.test", "MOCK-POS-CRM-AGT", "active", "MOCK-EMP-1002");
  await employee("MOCK-EMP-T004", "Patricia Lim", "patricia.lim@johnvivz.test", "MOCK-POS-CRM-AGT", "active", "MOCK-EMP-T002");
  await employee("MOCK-EMP-T005", "Edwin Sarmiento", "edwin.sarmiento@johnvivz.test", "MOCK-POS-CRM-AGT", "separated", "MOCK-EMP-1002");

  const team1 = await CrmTeam.findOne({ where: { team_code: "TEAM-01" }, raw: true });
  const manager = await CrmUser.findOne({ where: { role: "crm_manager" }, raw: true });
  const team2 = await CrmTeam.create({ team_code: "TEST-02", name: "Orders & Delivery Team (test)", manager_id: manager.id });
  const staff = async (employeeId, role, email, name, teamId, extra = {}) =>
    (await CrmUser.create({ user_type: "staff", role, employee_id: employeeId, email, password_hash: hash, display_name: name, team_id: teamId, ...extra })).get({ plain: true });
  const joseph = await staff("MOCK-EMP-T002", "team_leader", "joseph.villanueva@johnvivz.test", "Joseph Villanueva", team2.id);
  await staff("MOCK-EMP-T003", "agent", "ramon.aquino@johnvivz.test", "Ramon Aquino", team1.id);
  const patricia = await staff("MOCK-EMP-T004", "agent", "patricia.lim@johnvivz.test", "Patricia Lim", team2.id);
  await staff("MOCK-EMP-T005", "agent", "edwin.sarmiento@johnvivz.test", "Edwin Sarmiento", team1.id,
    { access_revoked_at: new Date(), access_revoked_reason: "HR employment status: separated" });
  await team2.update({ team_leader_id: joseph.id });
  out.team2 = team2.id;
  out.patricia = patricia.id;

  // One customer, two cases: team 1 (the demo agent) and team 2 (Patricia).
  const { customer, user } = await registerPortalCustomer({
    firstName: "Fixture", lastName: "Customer", email: "fixture.customer@example.test", mobile: "0917 000 9999", address: "Calapan", passwordHash: hash,
  });
  const cat = await CaseCategory.findOne({ raw: true });
  const asCustomer = { id: user.id, role: "customer", customer_id: customer.id, name: "Fixture Customer" };
  const asManager = { id: manager.id, role: "crm_manager", name: manager.display_name };
  const kristine = await CrmUser.findOne({ where: { email: "kristine.bautista@johnvivz.test" }, raw: true });
  for (const [key, subject, agentId] of [["team1Case", "FIXTURE case for team 1", kristine.id], ["team2Case", "FIXTURE case for team 2", patricia.id]]) {
    const k = await createCase({
      user: asCustomer,
      data: { case_type: "complaint", category_id: cat.id, subject, description: "Fixture case created for the access tests.", priority: "medium", order_reference: null },
    });
    await assignCase({ caseId: k.id, actor: asManager, agentId });
    out[key] = k.id;
    out[`${key}No`] = k.case_no;
  }
  console.log(JSON.stringify(out));
} catch (err) {
  console.error("Fixture setup failed:", err.message);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
