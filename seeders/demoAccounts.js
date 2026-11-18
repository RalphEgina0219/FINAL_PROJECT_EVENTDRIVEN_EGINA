// Demo accounts created by `npm run seed`: exactly ONE demo account per role (three customers).
// All rows are flagged is_demo = 1. Staff come from the MOCK HR fixture
// (services/integration/fixtures/mockHr.js); the System Administrator is the setup-only account;
// customers register through the same portal service as real ones.
export const DEMO_PASSWORD = "Demo@1234";

export const DEMO_TEAMS = [
  { team_code: "TEAM-01", name: "Customer Care Team" },
];
// Team codes the demo seed has ever created. `npm run seed:clear` removes them once nothing real uses them.
export const DEMO_TEAM_CODES = ["TEAM-01", "TEAM-02"];

export const DEMO_SETUP_ADMIN = { name: "Carlos Mendoza", email: "admin@johnvivz.test" };

export const DEMO_CUSTOMERS = [
  { first: "Juan", last: "Cruz", email: "juan.cruz@johnvivz.test", mobile: "0917 555 0101", address: "Calapan City, Oriental Mindoro", portal: true },
  { first: "Ana", last: "Dela Rosa", email: "ana.delarosa@johnvivz.test", mobile: "0918 555 0102", address: "Naujan, Oriental Mindoro", portal: true },
  { first: "Liza", last: "Fernandez", email: "liza.fernandez@johnvivz.test", mobile: "0939 555 0104", address: "Pinamalayan, Oriental Mindoro", portal: true },
  // Walk-in customers: CRM records WITHOUT a login. They are not demo accounts and never appear on the login page (blueprint §7).
  { first: "Ernesto", last: "Valdez", email: null, mobile: "0961 555 0107", address: "Calapan City, Oriental Mindoro", portal: false },
  { first: "Teresita", last: "Gomez", email: null, mobile: "0977 555 0108", address: "Naujan, Oriental Mindoro", portal: false },
];
