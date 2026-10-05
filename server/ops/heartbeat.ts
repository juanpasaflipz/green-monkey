import type postgres from "postgres";

export interface Heartbeat {
  process: string;
  instanceId: string;
  version: string;
  detail: postgres.JSONValue;
}

/** Upserts the worker's liveness row; /api/ops/status reads it as the runtime role. */
export async function beat(sql: postgres.Sql, h: Heartbeat) {
  await sql`
    insert into ops_heartbeats(process, instance_id, version, beat_at, detail)
    values(${h.process}, ${h.instanceId}, ${h.version}, now(), ${sql.json(h.detail)})
    on conflict (process) do update
      set instance_id=excluded.instance_id, version=excluded.version,
          beat_at=now(), detail=excluded.detail`;
}
