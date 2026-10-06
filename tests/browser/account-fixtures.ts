import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { BrowserContext } from "@playwright/test";
import { connect } from "../../server/db.js";
import {
  createOwnerRestaurant,
  ownerCookie,
  signInGoogleOwner,
  withOwner,
} from "../../server/owner-accounts.js";
import { legalConfig } from "../../server/legal.js";
import { LEGAL_DOCUMENTS } from "../../shared/legal.js";
import { LEGAL_CI_ENV } from "../fixtures/legal-ci.js";

/**
 * The legal configuration the compiled browser server runs with (the
 * fictional CI set, LD-3): fixtures created in this process record the same
 * entity hash the server checks.
 */
export const PUBLISHED_LEGAL = legalConfig({ ...LEGAL_CI_ENV });
export const CURRENT_ACCEPTANCE = {
  terms: LEGAL_DOCUMENTS.terms.version,
  privacy: LEGAL_DOCUMENTS.privacy.version,
  dpa: LEGAL_DOCUMENTS.dpa.version,
};

/** Runtime and fixture-admin connections, local dev fixture only (owner.spec guard). */
export function fixtureDatabases(baseURL: string | undefined) {
  const runtime = new URL(process.env.DATABASE_URL ?? "http://invalid"),
    migration = new URL(process.env.MIGRATION_DATABASE_URL ?? "http://invalid"),
    base = new URL(baseURL ?? "http://invalid");
  if (
    !["localhost", "127.0.0.1"].includes(runtime.hostname) ||
    runtime.hostname !== migration.hostname ||
    runtime.port !== migration.port ||
    runtime.pathname !== migration.pathname ||
    !/^\/green_monkey(_[a-z]+)?_dev$/.test(runtime.pathname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw Error("Account fixtures require the isolated local dev database");
  return {
    sql: connect(process.env.DATABASE_URL!),
    admin: postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1 }),
  };
}

export type OwnerFixture = {
  cookie: string;
  accountId: string;
  email: string;
  name: string;
};
/** A verified Google identity (not Google's external flow), as in owner.spec. */
export async function ownerFixture(
  sql: postgres.Sql,
  label: string,
): Promise<OwnerFixture> {
  const tag = randomUUID().slice(0, 8);
  const email = `${label}-${tag}@example.com`,
    name = `Fictional ${label} ${tag}`;
  const cookie = await signInGoogleOwner(sql, {
    issuer: "https://accounts.google.com",
    subject: randomUUID(),
    email,
    name,
  });
  return { cookie, accountId: ownerCookie(cookie).accountId, email, name };
}

/** A Free restaurant created with the current documents accepted. */
export async function ownerRestaurant(
  sql: postgres.Sql,
  owner: OwnerFixture,
  restaurantName: string,
) {
  const created = await withOwner(sql, owner.cookie, undefined, (tx, a) =>
    createOwnerRestaurant(
      tx,
      a,
      {
        restaurantName,
        currency: "MXN",
        timezone: "America/Mexico_City",
        cutoff: 240,
        openingDays: [1, 2, 3, 4, 5, 6, 7],
        locale: "es",
        legalAccepted: CURRENT_ACCEPTANCE,
      },
      PUBLISHED_LEGAL,
    ),
  );
  return created.tenantId as string;
}

export async function useOwnerCookie(
  context: BrowserContext,
  owner: OwnerFixture,
  baseURL: string | undefined,
) {
  await context.addCookies([
    {
      name: "gm_account",
      value: owner.cookie,
      url: new URL(baseURL!).origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

/**
 * Removes the account (031) rows a browser fixture created for these owner
 * accounts: legal acceptances, co-owner rows, transfers, recovery codes,
 * account events and tax profiles. Several are append-only or guarded, so this
 * runs as one admin transaction with the named triggers disabled (LD-12): no
 * other session ever sees them disabled, and a failed cleanup rolls the switch
 * back with the deletes. Order follows the foreign keys (LD-16 L5): recovery
 * codes and co-owner rows reference transfers; acceptances reference owner
 * sessions, which the caller deletes afterwards with the restaurants.
 */
export async function deleteAccountRows(
  admin: postgres.Sql,
  accountIds: string[],
) {
  if (!accountIds.length) return;
  await admin.begin(async (tx) => {
    const organizations = (
      await tx`select id from organizations where created_by_account in ${tx(accountIds)}
        union select organization_id from organization_co_owners where account_id in ${tx(accountIds)}
        union select organization_id from ownership_transfers
          where from_account_id in ${tx(accountIds)} or to_account_id in ${tx(accountIds)}`
    ).map((r) => r.id as string);
    await tx`alter table account_recovery_codes disable trigger recovery_code_guard`;
    await tx`alter table organization_co_owners disable trigger co_owner_guard`;
    await tx`alter table ownership_transfers disable trigger ownership_transfer_guard`;
    await tx`alter table account_events disable trigger account_events_append_only`;
    await tx`alter table legal_acceptances disable trigger legal_acceptances_append_only`;
    await tx`delete from account_recovery_codes where account_id in ${tx(accountIds)}
      or used_by_account in ${tx(accountIds)}`;
    if (organizations.length) {
      await tx`delete from organization_co_owners where organization_id in ${tx(organizations)}`;
      await tx`delete from account_events where organization_id in ${tx(organizations)}`;
      await tx`delete from organization_tax_profiles where organization_id in ${tx(organizations)}`;
      await tx`delete from legal_acceptances where organization_id in ${tx(organizations)}`;
      await tx`delete from ownership_transfers where organization_id in ${tx(organizations)}`;
    }
    await tx`delete from organization_co_owners where account_id in ${tx(accountIds)}`;
    await tx`delete from account_events where actor_account_id in ${tx(accountIds)}
      or subject_account_id in ${tx(accountIds)}`;
    await tx`delete from legal_acceptances where account_id in ${tx(accountIds)}`;
    // Run the deferred foreign-key checks now: a table with pending trigger
    // events cannot be altered back.
    await tx`set constraints all immediate`;
    await tx`alter table legal_acceptances enable trigger legal_acceptances_append_only`;
    await tx`alter table account_events enable trigger account_events_append_only`;
    await tx`alter table ownership_transfers enable trigger ownership_transfer_guard`;
    await tx`alter table organization_co_owners enable trigger co_owner_guard`;
    await tx`alter table account_recovery_codes enable trigger recovery_code_guard`;
    for (const organization of organizations) {
      const tenants =
        await tx`select id from restaurants where organization_id=${organization}`;
      for (const { id } of tenants) {
        await tx`select set_config('app.tenant_id',${id},true)`;
        await tx`delete from restaurant_account_settings where tenant_id=${id}`;
      }
    }
  });
}

/**
 * Deletes owner fixtures whose restaurants never sold (owner.spec's list plus
 * the account rows): the restaurants of their organizations, the
 * organizations, owner sessions and accounts.
 */
export async function deleteOwnerFixtures(
  admin: postgres.Sql,
  accountIds: string[],
) {
  if (!accountIds.length) return;
  const organizations = (
    await admin`select id from organizations where created_by_account in ${admin(accountIds)}
      union select r.organization_id from owner_memberships m join restaurants r on r.id=m.tenant_id
        where m.account_id in ${admin(accountIds)}`
  ).map((r) => r.id as string);
  await deleteAccountRows(admin, accountIds);
  const tenants = organizations.length
    ? (
        await admin`select id from restaurants where organization_id in ${admin(organizations)}`
      ).map((r) => r.id as string)
    : [];
  for (const tenant of tenants) {
    await admin`delete from signup_billing_intents where tenant_id=${tenant}`;
    await admin`delete from restaurant_invitations where tenant_id=${tenant}`;
    await admin`delete from owner_location_commands where tenant_id=${tenant}`;
    await admin`delete from restaurant_entitlements where tenant_id=${tenant}`;
    await admin`delete from operations where tenant_id=${tenant}`;
    await admin`delete from audit where tenant_id=${tenant}`;
    await admin`delete from sessions where tenant_id=${tenant}`;
    await admin`delete from owner_browser_devices where tenant_id=${tenant}`;
    await admin`delete from devices where tenant_id=${tenant}`;
    await admin`delete from owner_memberships where tenant_id=${tenant}`;
    await admin`delete from employees where tenant_id=${tenant}`;
    await admin`delete from restaurants where id=${tenant}`;
  }
  await admin`delete from owner_memberships where account_id in ${admin(accountIds)}`;
  if (organizations.length)
    await admin`delete from organizations where id in ${admin(organizations)}`;
  await admin`delete from owner_sessions where account_id in ${admin(accountIds)}`;
  await admin`delete from owner_accounts where id in ${admin(accountIds)}`;
}
