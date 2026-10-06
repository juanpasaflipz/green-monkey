// Reports (029): the employee and device lists behind the report filters.
import type { Tx } from "../db.js";
import { permit, managers } from "../auth.js";
import type { Session } from "../../shared/domain.js";

export type ReportFilters = {
  employees: { id: string; name: string; role: string; active: boolean }[];
  devices: { id: string; name: string; active: boolean; revoked: boolean }[];
};

/** GET /api/reports/filters: every employee and device of the location, by name. */
export async function reportFilters(
  tx: Tx,
  s: Session,
): Promise<ReportFilters> {
  permit(s, managers);
  const [employees, devices] = await Promise.all([
    tx<ReportFilters["employees"]>`
      select id, name, role, active from employees order by name, id`,
    tx<ReportFilters["devices"]>`
      select id, name, active, (revoked_at is not null) as revoked from devices order by name, id`,
  ]);
  return {
    employees: employees.map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
      active: e.active,
    })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      active: d.active,
      revoked: d.revoked,
    })),
  };
}
