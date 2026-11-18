/*
 * Human-readable numbers from number_sequences. The counter row stays locked until the surrounding
 * transaction commits, so two records created at the same moment never get the same number.
 *   case      JVT-YYYYMMDD-0001 (daily)      inquiry INQ-YYYYMMDD-0001
 *   order     SO-YYYYMMDD-0001               sale    SALE-YYYYMMDD-0001
 *   refund    RFD-YYYYMMDD-0001              customer CUS-000001 (running)
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../models/index.js";
import { isoDay } from "../helpers/dates.js";

const PREFIX = { case: "JVT", inquiry: "INQ", order: "SO", sale: "SALE", refund: "RFD" };

const bump = async (scope, period, transaction) => {
  await sequelize.query(
    `INSERT INTO number_sequences (scope, period, last_no) VALUES (:scope, :period, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)`,
    { replacements: { scope, period }, transaction }
  );
  const [row] = await sequelize.query("SELECT LAST_INSERT_ID() AS n", { type: QueryTypes.SELECT, transaction });
  return Number(row.n);
};

export const nextDailyNumber = async (scope, date, transaction) => {
  const day = isoDay(date).replaceAll("-", "");
  const n = await bump(scope, day, transaction);
  return `${PREFIX[scope]}-${day}-${String(n).padStart(4, "0")}`;
};

export const nextCustomerNumber = async (transaction) => `CUS-${String(await bump("customer", "ALL", transaction)).padStart(6, "0")}`;
