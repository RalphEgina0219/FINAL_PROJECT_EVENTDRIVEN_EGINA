// Finds a MySQL command-line tool (mysql, mysqldump): PATH first, then Laragon and XAMPP's usual folders.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export const findMysqlTool = (name) => {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim().split(/\r?\n/)[0];
  const roots = ["C:\\laragon\\bin\\mysql", "C:\\laragon\\bin\\mariadb"];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const v of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, v, "bin", exe);
      if (fs.existsSync(p)) return p;
    }
  }
  const xampp = path.join("C:\\xampp\\mysql\\bin", exe);
  return fs.existsSync(xampp) ? xampp : null;
};
