import type postgres from "postgres";

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
