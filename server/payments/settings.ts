// Payments configuration (037; spec §4.4, LD-72): named terminals, delivery platforms and their
// commissions, per-platform product prices, and each device's default terminal; plus the reads
// the payment dialog (operators) and Configuración (managers) need.
//
// Lock order (ARCHITECTURE row 46): 1 (once) → 2 (restaurants FOR SHARE in once) → 3 (the
// payments configuration key, advisory class 934) → the configuration rows (LO-3; the price
// save bumps menu_state first, so clients reprice). Plain reads elsewhere.
import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { managers, operators, permit } from "../auth.js";
import { requireRecentAuth } from "../access.js";
import { audit, once } from "../orders.js";
import { bumpMenuRevision } from "../menu.js";
import { DomainError, id, type Session } from "../../shared/domain.js";
import {
  archiveTerminalInput,
  PAYMENTS_LIMITS,
  PLATFORMS,
  saveTerminalInput,
  savePlatformPricesInput,
  savePlatformsInput,
  setDeviceTerminalInput,
  type PaymentOptions,
  type PaymentSettingsView,
  type Provider,
  type TerminalKind,
} from "../../shared/payments.js";
import { integratedProviders, terminalStatus } from "./providers.js";

/** LO-3 area key, class 934 (critic R3): every payments configuration write. */
async function lockPaymentsConfig(tx: Tx, s: Session) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${s.tenantId + ":payments"},934))`;
}

const KIND_PROVIDER: Record<TerminalKind, string | null> = {
  manual: null,
  mercadopago_point: "mercadopago",
  clip_pinpad: "clip",
};

/** What PaymentDialog needs (operators); commissions and fees for managers only. */
export async function paymentOptions(
  tx: Tx,
  s: Session,
): Promise<PaymentOptions> {
  permit(s, operators);
  const manager = managers.includes(s.role);
  const [terminals, platforms, defaults, devices, integrated] =
    await Promise.all([
      tx`select id,name,kind,fee_bp,provider_device_id from payment_terminals
      where active and archived_at is null order by lower(name),id`,
      tx`select platform,enabled,commission_bp from payment_platforms`,
      tx`select terminal_id from payment_device_terminals where device_id=${s.deviceId}`,
      tx`select provider,device_id,status,seen_at from payment_provider_devices`,
      integratedProviders(tx),
    ]);
  // P2: an integrated terminal charges through its provider when the worker serves the provider
  // and the restaurant's account is active; it can always take a manual record.
  const live = (kind: TerminalKind) => {
    const provider = KIND_PROVIDER[kind] as Provider | null;
    return Boolean(
      provider &&
      integrated.served.includes(provider) &&
      integrated.accounts.get(provider)?.state === "active",
    );
  };
  const enabled = PLATFORMS.flatMap((platform) => {
    const row = platforms.find((p) => p.platform === platform);
    if (row && !row.enabled) return [];
    return [
      {
        platform,
        ...(manager ? { commissionBp: row?.commission_bp ?? null } : {}),
      },
    ];
  });
  const defaultId = defaults[0]?.terminal_id ?? null;
  return {
    terminals: terminals.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      ...(manager ? { feeBp: t.fee_bp ?? null } : {}),
      integrated: live(t.kind),
      ...(KIND_PROVIDER[t.kind as TerminalKind]
        ? {
            status: terminalStatus(
              devices.find(
                (d) =>
                  d.provider === KIND_PROVIDER[t.kind as TerminalKind] &&
                  d.device_id === t.provider_device_id,
              ) as { status: string | null; seen_at: Date } | undefined,
            ),
          }
        : {}),
    })),
    platforms: enabled,
    defaultTerminalId: terminals.some((t) => t.id === defaultId)
      ? defaultId
      : null,
    integratedAvailable: terminals.some((t) => live(t.kind)),
  };
}

/** Configuración → Pagos con tarjeta y plataformas (managers). */
export async function paymentSettingsView(
  tx: Tx,
  s: Session,
): Promise<PaymentSettingsView> {
  permit(s, managers);
  const [terminals, platforms, prices, devices, defaults] = await Promise.all([
    tx`select id,name,kind,provider_device_id,fee_bp,active,archived_at,version
      from payment_terminals order by archived_at nulls first,lower(name),id`,
    tx`select platform,enabled,commission_bp,version from payment_platforms`,
    tx`select product_id,platform,price,version from payment_platform_prices`,
    tx`select id,name from devices where active and revoked_at is null order by name,id`,
    tx`select device_id,terminal_id from payment_device_terminals`,
  ]);
  return {
    terminals: terminals.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      providerDeviceId: t.provider_device_id ?? null,
      feeBp: t.fee_bp ?? null,
      active: t.active,
      archivedAt: t.archived_at ? new Date(t.archived_at).toISOString() : null,
      version: t.version,
      defaultOn: devices
        .filter((d) =>
          defaults.some((x) => x.device_id === d.id && x.terminal_id === t.id),
        )
        .map((d) => d.name as string),
    })),
    platforms: PLATFORMS.map((platform) => {
      const row = platforms.find((p) => p.platform === platform);
      return {
        platform,
        enabled: row ? row.enabled : true,
        commissionBp: row?.commission_bp ?? null,
        version: row?.version ?? 0,
      };
    }),
    prices: prices.map((p) => ({
      productId: p.product_id,
      platform: p.platform,
      price: p.price ?? null,
      version: p.version,
    })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      terminalId:
        defaults.find((x) => x.device_id === d.id)?.terminal_id ?? null,
    })),
  };
}

/** Add or edit a terminal (managers, step-up). Integrated kinds need an active provider account. */
export async function saveTerminal(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = saveTerminalInput.parse(raw);
  requireRecentAuth(s);
  return once(tx, s, p.operationId, "payments.terminal", p, async () => {
    await lockPaymentsConfig(tx, s);
    const provider = KIND_PROVIDER[p.kind];
    if ((provider === null) !== (p.providerDeviceId === undefined))
      throw new DomainError("invalid_input");
    const name = p.name.trim();
    const [taken] = await tx`select id from payment_terminals
      where archived_at is null and lower(btrim(name))=lower(${name})
        and id is distinct from ${p.terminalId ?? null}::uuid`;
    if (taken) throw new DomainError("payments_terminal_name_taken", 409);
    let terminalId = p.terminalId;
    if (!terminalId) {
      if (provider) {
        const [account] =
          await tx`select state from payment_provider_accounts where provider=${provider}`;
        if (account?.state !== "active")
          throw new DomainError("payments_provider_not_configured", 409);
        const [device] = await tx`select id from payment_terminals
          where archived_at is null and kind=${p.kind} and provider_device_id=${p.providerDeviceId!}`;
        if (device) throw new DomainError("payments_device_taken", 409);
      }
      const [{ n }] =
        await tx`select count(*)::int as n from payment_terminals where archived_at is null`;
      if (n >= PAYMENTS_LIMITS.terminals)
        throw new DomainError("payments_terminal_limit", 409);
      terminalId = randomUUID();
      await tx`insert into payment_terminals(tenant_id,id,name,kind,provider_device_id,fee_bp,active,
          created_by,updated_by)
        values(${s.tenantId},${terminalId},${name},${p.kind},${p.providerDeviceId ?? null},${p.feeBp},
          ${p.active},${s.employeeId},${s.employeeId})`;
      await audit(tx, s, "payment.terminal_saved", terminalId, {
        created: true,
        name,
        kind: p.kind,
        feeBp: p.feeBp,
      });
    } else {
      const [row] = await tx`select kind,provider_device_id,archived_at,version
        from payment_terminals where id=${terminalId} for update`;
      if (!row) throw new DomainError("payments_terminal_not_found", 404);
      if (row.archived_at)
        throw new DomainError("payments_terminal_inactive", 409);
      if (
        row.kind !== p.kind ||
        (row.provider_device_id ?? undefined) !== p.providerDeviceId
      )
        throw new DomainError("invalid_input");
      if (p.expectedVersion !== undefined && row.version !== p.expectedVersion)
        throw new DomainError("payments_settings_changed", 409);
      await tx`update payment_terminals set name=${name},fee_bp=${p.feeBp},active=${p.active},
          version=version+1,updated_at=now(),updated_by=${s.employeeId}
        where id=${terminalId}`;
      await audit(tx, s, "payment.terminal_saved", terminalId, {
        created: false,
        name,
        feeBp: p.feeBp,
        active: p.active,
      });
    }
    return paymentSettingsView(tx, s);
  });
}

/** Archive a terminal (managers, step-up); refused while it may be showing a charge. */
export async function archiveTerminal(
  tx: Tx,
  s: Session,
  terminalId: string,
  raw: unknown,
) {
  permit(s, managers);
  id.parse(terminalId);
  const p = archiveTerminalInput.parse(raw);
  requireRecentAuth(s);
  return once(
    tx,
    s,
    p.operationId,
    "payments.terminal_archive",
    { terminalId, ...p },
    async () => {
      await lockPaymentsConfig(tx, s);
      const [row] =
        await tx`select archived_at,version from payment_terminals where id=${terminalId} for update`;
      if (!row) throw new DomainError("payments_terminal_not_found", 404);
      if (row.archived_at) return paymentSettingsView(tx, s);
      if (row.version !== p.expectedVersion)
        throw new DomainError("payments_settings_changed", 409);
      const [live] = await tx`select id from payment_attempts
        where terminal_id=${terminalId} and state in ('created','sending','pending','unknown') limit 1`;
      if (live) throw new DomainError("payments_terminal_busy", 409);
      await tx`update payment_terminals set active=false,archived_at=now(),archived_by=${s.employeeId},
          version=version+1,updated_at=now(),updated_by=${s.employeeId}
        where id=${terminalId}`;
      await audit(tx, s, "payment.terminal_archived", terminalId, {});
      return paymentSettingsView(tx, s);
    },
  );
}

/** Enable platforms and set their estimated commissions (managers, step-up). */
export async function savePlatforms(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = savePlatformsInput.parse(raw);
  requireRecentAuth(s);
  return once(tx, s, p.operationId, "payments.platforms", p, async () => {
    await lockPaymentsConfig(tx, s);
    const rows = await tx`select platform,version from payment_platforms
      where platform=any(${p.platforms.map((x) => x.platform)}::text[])
      order by platform for update`;
    for (const x of p.platforms) {
      const version = rows.find((r) => r.platform === x.platform)?.version ?? 0;
      if (version !== x.expectedVersion)
        throw new DomainError("payments_settings_changed", 409);
    }
    for (const x of p.platforms)
      await tx`insert into payment_platforms(tenant_id,platform,enabled,commission_bp,updated_by)
        values(${s.tenantId},${x.platform},${x.enabled},${x.commissionBp},${s.employeeId})
        on conflict (tenant_id,platform) do update set enabled=excluded.enabled,
          commission_bp=excluded.commission_bp,version=payment_platforms.version+1,
          updated_at=now(),updated_by=excluded.updated_by`;
    await audit(tx, s, "payment.platforms_saved", s.tenantId, {
      platforms: p.platforms.map(({ platform, enabled, commissionBp }) => ({
        platform,
        enabled,
        commissionBp,
      })),
    });
    return paymentSettingsView(tx, s);
  });
}

/**
 * Per-platform product prices (managers, step-up; LD-72). A null price clears it (the product
 * sells at its POS price on that platform). Bumps the menu revision so every POS reprices.
 */
export async function savePlatformPrices(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  const p = savePlatformPricesInput.parse(raw);
  requireRecentAuth(s);
  return once(tx, s, p.operationId, "payments.prices", p, async () => {
    await lockPaymentsConfig(tx, s);
    // LO-3 internal order: the serialization key, then menu_state (row lock), then rows.
    await bumpMenuRevision(tx);
    const productIds = [...new Set(p.prices.map((x) => x.productId))].sort();
    const products = await tx`select id from catalog
      where id=any(${productIds}::uuid[]) and not coalesce((data->>'archived')::boolean,false)`;
    if (products.length !== productIds.length)
      throw new DomainError("not_found", 404);
    const rows =
      await tx`select product_id,platform,version from payment_platform_prices
      where product_id=any(${productIds}::uuid[]) order by product_id,platform for update`;
    for (const x of p.prices) {
      const version =
        rows.find(
          (r) => r.product_id === x.productId && r.platform === x.platform,
        )?.version ?? 0;
      if (version !== x.expectedVersion)
        throw new DomainError("payments_price_changed", 409);
    }
    for (const x of [...p.prices].sort((a, b) =>
      (a.productId + a.platform).localeCompare(b.productId + b.platform),
    ))
      await tx`insert into payment_platform_prices(tenant_id,product_id,platform,price,updated_by)
        values(${s.tenantId},${x.productId},${x.platform},${x.price},${s.employeeId})
        on conflict (tenant_id,product_id,platform) do update set price=excluded.price,
          version=payment_platform_prices.version+1,updated_at=now(),updated_by=excluded.updated_by`;
    await audit(tx, s, "payment.platform_prices_saved", s.tenantId, {
      prices: p.prices.map(({ productId, platform, price }) => ({
        productId,
        platform,
        price,
      })),
    });
    return paymentSettingsView(tx, s);
  });
}

/**
 * A device's default terminal: operators for their own device, managers for any. null clears
 * it. The terminal must be active.
 */
export async function setDeviceTerminal(
  tx: Tx,
  s: Session,
  deviceId: string,
  raw: unknown,
) {
  permit(s, operators);
  id.parse(deviceId);
  if (deviceId !== s.deviceId && !managers.includes(s.role))
    throw new DomainError("forbidden", 403);
  const p = setDeviceTerminalInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "payments.device_terminal",
    { deviceId, ...p },
    async () => {
      await lockPaymentsConfig(tx, s);
      const [device] =
        await tx`select id from devices where id=${deviceId} and active and revoked_at is null`;
      if (!device) throw new DomainError("not_found", 404);
      if (p.terminalId) {
        const [t] =
          await tx`select id from payment_terminals where id=${p.terminalId} and active and archived_at is null`;
        if (!t) throw new DomainError("payments_terminal_inactive", 409);
      }
      await tx`insert into payment_device_terminals(tenant_id,device_id,terminal_id,updated_by)
        values(${s.tenantId},${deviceId},${p.terminalId},${s.employeeId})
        on conflict (tenant_id,device_id) do update set terminal_id=excluded.terminal_id,
          updated_at=now(),updated_by=excluded.updated_by`;
      await audit(tx, s, "payment.device_terminal_set", deviceId, {
        terminalId: p.terminalId,
      });
      return { deviceId, terminalId: p.terminalId as string | null };
    },
  );
}
