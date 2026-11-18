/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import { config } from "./config/index.js";
import { productionProblems } from "./config/productionCheck.js";
import express from "express";
import { registerViewHelpers } from "./helpers/viewHelpers.js";
import { loadUser, auditSetupAdmin } from "./middleware/auth.js";
import { csrfToken, csrfProtection } from "./middleware/csrf.js";
import { securityHeaders, noStore } from "./middleware/security.js";
import { loadSettings } from "./services/settingsService.js";
import { loadPermissions } from "./services/permissionService.js";
import { startScheduler } from "./jobs/scheduler.js";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
import integrationApi from "./routes/integrationApi.js";
import fs from 'fs';
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = config.port;

app.disable("x-powered-by");
if (config.session.trustProxy) app.set("trust proxy", 1);
app.use(securityHeaders);
// Signed machine-to-machine API (P6): no session, no cookies, no CSRF; it reads the raw body itself to check the HMAC signature.
app.use("/api/integration", integrationApi);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(express.static(path.join(process.cwd(), "public")));

app.use(session({
  name: "jvt.sid",
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: config.session.secureCookie, maxAge: config.session.maxAgeHours * 3600 * 1000 }
}));
app.use(flash());
registerViewHelpers(hbs);

const registerPartials = () => {
  const dir = path.join(__dirname, "views/partials");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".xian"))) {
    hbs.registerPartial(file.replace(".xian", ""), fs.readFileSync(path.join(dir, file), "utf8"));
  }
};
registerPartials();

app.engine("xian", async (filePath, options, callback) => {
  try {
    if (config.env !== "production") registerPartials(); // pick up partial edits without restart
     const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, 'views');

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");

app.use(csrfToken);
app.use(loadUser);
app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  res.locals.info_msg = req.flash("info_msg");
  next();
});
app.use(noStore);
app.use(auditSetupAdmin);
app.use(csrfProtection);

app.use("/", router);

app.use((req, res) => {
  res.status(404).render("error", { title: "Page not found", status: 404, message: "The page you are looking for does not exist." });
});
app.use((err, req, res, next) => {
  console.error("❌", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).render("error", {
    title: "Something went wrong", status: err.status || 500,
    message: err.expose ? err.message : "An unexpected error occurred. Please try again.",
  });
});

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = async (port = PORT) => {
  const { errors, warnings } = productionProblems(config);
  for (const w of warnings) console.warn(`⚠️  ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`❌ ${e}`);
    throw new Error("Refusing to start in production until the .env problems above are fixed (docs/DEPLOYMENT.md).");
  }
  await loadSettings(); // CRM rules (crm_settings) and SLA targets (service_targets)
  await loadPermissions(); // role-permission matrix (roles, permissions, role_permissions)
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 XianFire running at http://localhost:${port}`);
      if (!process.env.DISABLE_SCHEDULER) startScheduler(); // auto-close + SLA alerts every 5 minutes; the integration dispatcher every 20 seconds
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer().catch((err) => { console.error(`❌ ${err.message}`); process.exit(1); });
}
