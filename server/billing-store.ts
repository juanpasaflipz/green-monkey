import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Tx } from "./db.js";
import { DomainError } from "../shared/domain.js";
import type { Entitlement } from "../shared/plans.js";

export async function checkBillingRole(sql: postgres.Sql) {
  const [r] =
    await sql`select rolsuper,rolbypassrls,pg_has_role(current_user,'gm_billing_worker','member') as billing from pg_roles where rolname=current_user`;
  const [o] =
    await sql`select 1 from pg_tables where schemaname='public' and tableowner=current_user limit 1`;
  if (!r.billing || r.rolsuper || r.rolbypassrls || o)
    throw Error("restricted_billing_role_required");
}

export function billingStore(sql: postgres.Sql) {
  const transaction = <T>(fn: (tx: Tx) => Promise<T>) =>
    sql.begin((raw) => fn(raw as Tx)) as Promise<T>;
  return {
    async request(
      accountId: string,
      tenantId: string,
      kind: "trial" | "checkout" | "portal",
      interval: "month" | "year",
    ) {
      return transaction(async (tx) => {
        const [restaurant] =
          await tx`select r.organization_id from restaurants r join organizations o on o.id=r.organization_id where r.id=${tenantId} and o.created_by_account=${accountId}`;
        if (!restaurant) throw new DomainError("forbidden", 403);
        const org = restaurant.organization_id as string;
        await tx`select pg_advisory_xact_lock(hashtextextended(${org},711))`;
        await tx`insert into organization_billing(organization_id) values(${org}) on conflict do nothing`;
        const [billing] =
          await tx`select * from organization_billing where organization_id=${org} for update`;
        const [pending] =
          await tx`select id,kind,state,payload from billing_operations where organization_id=${org} and state in ('pending','running','review') and kind in ('customer','trial','checkout','checkout_watch')`;
        if (pending) {
          if (
            pending.payload.next !== kind ||
            pending.payload.interval !== interval
          )
            throw new DomainError("billing_request_pending", 409);
          return { operationId: pending.id, state: pending.state };
        }
        if (kind === "trial" && (billing.trial_used || billing.subscription_id))
          throw new DomainError("trial_already_used", 409);
        const [current] =
          await tx`select status from restaurant_entitlements where tenant_id=${tenantId}`;
        if (
          kind === "checkout" &&
          billing.subscription_id &&
          current?.status !== "canceled"
        )
          throw new DomainError("billing_use_existing_subscription", 409);
        if (kind === "portal" && !billing.customer_id)
          throw new DomainError("billing_customer_pending", 409);
        const [other] =
          await tx`select tenant_id from billing_locations where organization_id=${org} and tenant_id<>${tenantId}`;
        if (other)
          throw new DomainError("billing_location_change_required", 409);
        await tx`insert into billing_locations(organization_id,tenant_id) values(${org},${tenantId}) on conflict do nothing`;
        const id = randomUUID();
        const payload = { interval, next: kind, tenantId };
        await tx`insert into billing_operations(id,organization_id,kind,payload) values(${id},${org},${billing.customer_id ? kind : "customer"},${tx.json(payload)})`;
        return { operationId: id, state: "pending" };
      });
    },
    async status(accountId: string, tenantId: string) {
      const [r] =
        await sql`select r.organization_id from restaurants r join organizations o on o.id=r.organization_id where r.id=${tenantId} and o.created_by_account=${accountId}`;
      if (!r) throw new DomainError("forbidden", 403);
      const [billing] =
        await sql`select trial_used,subscription_id is not null as has_subscription,interval from organization_billing where organization_id=${r.organization_id}`;
      const [operation] =
        await sql`select kind,state,result,created_at from billing_operations where organization_id=${r.organization_id} and kind<>'reconcile' order by created_at desc,id desc limit 1`;
      const [entitlement] =
        await sql`select status,access_until from restaurant_entitlements where tenant_id=${tenantId}`;
      let hostedUrl: string | null = null;
      if (
        operation?.kind === "portal" &&
        operation.state === "succeeded" &&
        Date.now() - new Date(operation.created_at).getTime() < 300000
      )
        hostedUrl = operation.result?.url ?? null;
      if (
        operation?.kind === "checkout_watch" &&
        ["pending", "running"].includes(operation.state)
      ) {
        const [session] =
          await sql`select result from billing_operations where organization_id=${r.organization_id} and kind='checkout' and state='succeeded' order by created_at desc limit 1`;
        hostedUrl = session?.result?.url ?? null;
      }
      return {
        hostedUrl,
        billing: billing ?? null,
        operation: operation ?? null,
        entitlement: entitlement ?? null,
      };
    },
    async event(id: string, subscriptionId: string) {
      await sql`insert into billing_events(id,subscription_id) values(${id},${subscriptionId}) on conflict do nothing`;
    },
    async signupIntents() {
      const rows =
        await sql`select i.tenant_id,i.trial_requested,o.created_by_account from signup_billing_intents i join restaurants r on r.id=i.tenant_id join organizations o on o.id=r.organization_id where i.processed_at is null order by i.created_at limit 20`;
      for (const row of rows) {
        if (row.trial_requested) {
          try {
            await this.request(
              row.created_by_account,
              row.tenant_id,
              "trial",
              "month",
            );
          } catch (error) {
            if (!(
              error instanceof DomainError &&
              ["trial_already_used", "billing_request_pending"].includes(
                error.code,
              )
            ))
              throw error;
          }
        }
        await sql`update signup_billing_intents set processed_at=now() where tenant_id=${row.tenant_id}`;
      }
    },
    async schedule() {
      return transaction(async (tx) => {
        // Events arriving before a creation response remain in the inbox until
        // the durable binding exists. Snapshot metadata never creates a binding.
        const rows =
          await tx`select b.organization_id from organization_billing b where b.subscription_id is not null and (b.updated_at<now()-interval '15 minutes' or exists(select 1 from billing_events e where e.subscription_id=b.subscription_id and e.processed_at is null))`;
        for (const row of rows) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${row.organization_id},711))`;
          const [pending] =
            await tx`select id from billing_operations where organization_id=${row.organization_id} and kind='reconcile' and state in ('pending','running')`;
          if (!pending)
            await tx`insert into billing_operations(id,organization_id,kind,payload) values(${randomUUID()},${row.organization_id},'reconcile','{}')`;
        }
      });
    },
    async claim() {
      return transaction(async (tx) => {
        const [op] =
          await tx`select op.* from billing_operations op where op.state in ('pending','running') and op.available_at<=now() and (op.lease_until is null or op.lease_until<now()) and not exists(select 1 from billing_operations busy where busy.organization_id=op.organization_id and busy.state='running' and busy.lease_until>=now()) order by op.created_at,op.id for update skip locked limit 1`;
        if (!op) return null;
        await tx`select pg_advisory_xact_lock(hashtextextended(${op.organization_id},711))`;
        const [busy] =
          await tx`select 1 from billing_operations where organization_id=${op.organization_id} and state='running' and lease_until>=now()`;
        if (busy) return null;
        // Stripe can prune keys after 24h. Uncertain old creations require
        // reconciliation by an operator, never a newly generated retry key.
        const [old] =
          await tx`select 1 from billing_operations where id=${op.id} and kind not in ('reconcile','checkout_watch') and first_attempt_at<now()-interval '23 hours'`;
        if (old) {
          await tx`update billing_operations set state='review',lease_until=null where id=${op.id}`;
          return null;
        }
        const token = randomUUID();
        const [clock] = await tx`select now() as claimed_at`;
        await tx`update billing_operations set state='running',lease_token=${token},lease_until=now()+interval '2 minutes',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),fetch_started_at=now() where id=${op.id}`;
        const [binding] =
          await tx`select * from organization_billing where organization_id=${op.organization_id}`;
        const [count] =
          await tx`select count(*)::int as locations from billing_locations where organization_id=${op.organization_id}`;
        return {
          ...op,
          id: op.id as string,
          kind: op.kind as string,
          organization_id: op.organization_id as string,
          payload: op.payload as {
            interval: "month" | "year";
            next: string;
            tenantId: string;
            sessionId?: string;
          },
          lease_token: token,
          first_attempt_at: clock.claimed_at,
          binding,
          locations: count.locations,
        };
      });
    },
    async complete(
      id: string,
      token: string,
      result: Record<string, unknown>,
      entitlement?: Entitlement,
    ) {
      return transaction(async (tx) => {
        const [op] =
          await tx`select * from billing_operations where id=${id} and lease_token=${token} and state='running' and lease_until>=now() for update`;
        if (!op) return false;
        await tx`select pg_advisory_xact_lock(hashtextextended(${op.organization_id},711))`;
        if (op.kind === "customer") {
          await tx`update organization_billing set customer_id=${String(result.customerId)},version=version+1,updated_at=now() where organization_id=${op.organization_id}`;
        }
        if (
          op.kind === "trial" ||
          (op.kind === "checkout_watch" && result.subscriptionId)
        ) {
          await tx`update organization_billing set subscription_id=${String(result.subscriptionId)},trial_used=trial_used or ${op.kind === "trial"},interval=${op.payload.interval},version=version+1,updated_at=now() where organization_id=${op.organization_id}`;
        }
        if (op.kind === "checkout")
          await tx`update organization_billing set interval=${op.payload.interval} where organization_id=${op.organization_id}`;
        if (entitlement) {
          await tx`update organization_billing set version=version+1,updated_at=now() where organization_id=${op.organization_id}`;
          const rows =
            await tx`select tenant_id from billing_locations where organization_id=${op.organization_id}`;
          for (const row of rows)
            await tx`insert into restaurant_entitlements(tenant_id,status,access_until,trial_used,source) values(${row.tenant_id},${entitlement.status},${entitlement.accessUntil},true,'stripe') on conflict(tenant_id) do update set status=excluded.status,access_until=excluded.access_until,source='stripe',trial_used=restaurant_entitlements.trial_used or excluded.trial_used,version=restaurant_entitlements.version+1,updated_at=now()`;
          // Only events present before this fetch are acknowledged. A later event
          // forces a fresh canonical read after this transaction commits.
          await tx`update billing_events set processed_at=now() where subscription_id=(select subscription_id from organization_billing where organization_id=${op.organization_id}) and received_at<=${op.fetch_started_at}`;
        }
        await tx`update billing_operations set state='succeeded',result=${tx.json(result as postgres.JSONValue)},completed_at=now(),lease_until=null where id=${id}`;
        if (op.kind === "checkout")
          await tx`insert into billing_operations(id,organization_id,kind,payload) values(${randomUUID()},${op.organization_id},'checkout_watch',${tx.json({ ...op.payload, sessionId: result.sessionId })})`;
        if (op.kind === "customer")
          await tx`insert into billing_operations(id,organization_id,kind,payload) values(${randomUUID()},${op.organization_id},${op.payload.next},${tx.json(op.payload)})`;
        if (op.kind === "trial")
          await tx`insert into billing_operations(id,organization_id,kind,payload) values(${randomUUID()},${op.organization_id},'reconcile','{}')`;
        return true;
      });
    },
    async retry(id: string, token: string) {
      await sql`update billing_operations set state='pending',lease_until=null,available_at=now()+interval '30 seconds' where id=${id} and lease_token=${token} and state='running'`;
    },
  };
}
