/*
 * Role-permission matrix (tables roles, permissions, role_permissions; seeded by migration 102).
 * Loaded into memory at startup; `can(user, code)` is used by middleware and services.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";

let matrix = new Map(); // role code -> Set(permission codes)

export const loadPermissions = async () => {
  const rows = await sequelize.query(
    `SELECT r.code AS role, p.code AS permission FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id`,
    { type: QueryTypes.SELECT }
  );
  const next = new Map();
  for (const { role, permission } of rows) {
    if (!next.has(role)) next.set(role, new Set());
    next.get(role).add(permission);
  }
  matrix = next;
  return matrix;
};

export const can = (user, permission) => Boolean(user && matrix.get(user.role)?.has(permission));

export const canAny = (user, ...permissions) => permissions.some((p) => can(user, p));

// For the README / settings page: role -> sorted permission list.
export const permissionMatrix = async () =>
  sequelize.query(
    `SELECT p.module, p.code, p.description,
            GROUP_CONCAT(r.code ORDER BY r.id SEPARATOR ',') AS roles
     FROM permissions p LEFT JOIN role_permissions rp ON rp.permission_id = p.id LEFT JOIN roles r ON r.id = rp.role_id
     GROUP BY p.id, p.module, p.code, p.description ORDER BY p.module, p.code`,
    { type: QueryTypes.SELECT }
  );
