// Kiosk staff configuration (039; specs/kiosk-w4.md §2.2, §4.6): the restaurant's kiosk settings,
// each station's terminal and receiving till, tablet pairing codes and unpairing, and the curated
// suggestions. Owners and managers; the settings, station and pairing saves need a fresh PIN
// (access SEC-6), unpairing never does.
//
// Lock order (ARCHITECTURE rows 60 and 63): 1 → 2 → 3 (kiosk_settings row | station row → its
// device rows) / suggestions: 1 → 2 → 3 menu_state → 3 menu_suggestions row.
import { randomInt, randomUUID } from "node:crypto";
import type { Tx } from "./db.js";
import { managers, permit } from "./auth.js";
import { requireRecentAuth } from "./access.js";
import { audit, once } from "./orders.js";
import { requireSelling } from "./free-limits.js";
import { bumpMenuRevision } from "./menu.js";
import { loyaltyKioskConfig } from "./loyalty/kiosk.js";
import { kioskSelfCheckoutEnabled } from "./kiosk-config.js";
import { kioskSettingsRow, pairingCodeHash } from "./kiosk-diner.js";
import {
  DomainError,
  id,
  type Product,
  type Session,
} from "../shared/domain.js";
import {
  KIOSK_LIMITS,
  kioskRevokeDeviceInput,
  kioskSettingsInput,
  kioskStationInput,
  suggestionsInput,
  type KioskSettingsView,
  type KioskStationView,
} from "../shared/kiosk.js";

/** GET /api/kiosk/settings (owners, managers): settings, stations, terminals, tills, cart set. */
export async function kioskSettingsView(
  tx: Tx,
  s: Session,
): Promise<KioskSettingsView> {
  permit(s, managers);
  const settings = await kioskSettingsRow(tx);
  const stations =
    await tx`select s.id,s.version,s.terminal_id,s.register_device_id,
      l.id as link_id,coalesce(l.label,'') as label,
      exists(select 1 from cash_sessions c where c.device_id=s.register_device_id and c.closed_at is null) as till_open,
      (select json_build_object('id',d.id,'paired',d.paired_at is not null,'pairing_expires_at',d.pairing_expires_at,
          'last_seen_at',d.last_seen_at,'build',d.build,'viewport',d.viewport)
        from kiosk_devices d where d.station_id=s.id and d.revoked_at is null) as device
    from kiosk_stations s
    left join public_links l on l.tenant_id=s.tenant_id and l.station_id=s.id and l.revoked_at is null
    where s.archived_at is null
    order by coalesce(l.label,''),s.created_at,s.id`;
  const terminals = await tx`select id,name,kind from payment_terminals
    where active and archived_at is null order by name,id`;
  const tills = await tx`select d.id,d.name,
      exists(select 1 from cash_sessions c where c.device_id=d.id and c.closed_at is null) as open
    from devices d where d.active order by d.name,d.id`;
  const [cart] =
    await tx`select product_ids,version from menu_suggestions where scope='cart'`;
  return {
    settings: {
      paymentMode: settings.payment_mode,
      askFulfillment: settings.ask_fulfillment,
      suggestions: settings.suggestions,
      loyaltyAtKiosk: settings.loyalty_at_kiosk,
      version: settings.version,
    },
    stations: stations.map((r): KioskStationView => ({
      id: r.id,
      version: r.version,
      linkId: r.link_id ?? null,
      label: r.label,
      terminalId: r.terminal_id,
      registerDeviceId: r.register_device_id,
      tillOpen: r.till_open,
      device: r.device
        ? {
            id: r.device.id,
            state: r.device.paired ? "paired" : "pending",
            pairingExpiresAt: r.device.pairing_expires_at ?? null,
            lastSeenAt: r.device.last_seen_at ?? null,
            build: r.device.build ?? null,
            viewport: r.device.viewport ?? null,
          }
        : null,
    })),
    terminals: terminals.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      integrated: t.kind !== "manual",
    })),
    tills: tills.map((t) => ({ id: t.id, name: t.name, open: t.open })),
    cartSuggestions: {
      productIds: (cart?.product_ids as string[] | undefined) ?? [],
      version: (cart?.version as number | undefined) ?? 0,
    },
    loyaltyAvailable: !!(await loyaltyKioskConfig(tx)),
    selfCheckoutEnabled: kioskSelfCheckoutEnabled(),
  };
}

/** PUT /api/kiosk/settings (step-up): "Cobro en el kiosco", "Preguntar…", "Sugerencias", "Club". */
export async function saveKioskSettings(tx: Tx, s: Session, raw: unknown) {
  permit(s, managers);
  requireRecentAuth(s);
  const p = kioskSettingsInput.parse(raw);
  return once(tx, s, p.operationId, "kiosk.settings", p, async () => {
    if (p.loyaltyAtKiosk && !(await loyaltyKioskConfig(tx)))
      throw new DomainError("loyalty_disabled", 409);
    const [row] = await tx`select version from kiosk_settings for update`;
    if (((row?.version as number | undefined) ?? 0) !== p.expectedVersion)
      throw new DomainError("kiosk_settings_changed", 409);
    const [r] = row
      ? await tx`update kiosk_settings set payment_mode=${p.paymentMode},
            ask_fulfillment=${p.askFulfillment},suggestions=${p.suggestions},
            loyalty_at_kiosk=${p.loyaltyAtKiosk},version=version+1,updated_at=now(),updated_by=${s.employeeId}
          returning version`
      : await tx`insert into kiosk_settings(tenant_id,payment_mode,ask_fulfillment,suggestions,loyalty_at_kiosk,updated_by)
          values(${s.tenantId},${p.paymentMode},${p.askFulfillment},${p.suggestions},${p.loyaltyAtKiosk},${s.employeeId})
          on conflict do nothing returning version`;
    // A concurrent first save inserted the row: the screen's version 0 is stale.
    if (!r) throw new DomainError("kiosk_settings_changed", 409);
    await audit(tx, s, "kiosk.settings_saved", s.tenantId, {
      paymentMode: p.paymentMode,
      askFulfillment: p.askFulfillment,
      suggestions: p.suggestions,
      loyaltyAtKiosk: p.loyaltyAtKiosk,
    });
    return { version: r.version as number };
  });
}

/** PUT /api/kiosk/stations/:id (step-up): "Terminal" and "Caja que recibe los cobros". */
export async function saveStation(
  tx: Tx,
  s: Session,
  stationId: string,
  raw: unknown,
) {
  permit(s, managers);
  requireRecentAuth(s);
  id.parse(stationId);
  const p = kioskStationInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "kiosk.station",
    { stationId, ...p },
    async () => {
      const [st] =
        await tx`select version,archived_at from kiosk_stations where id=${stationId} for update`;
      if (!st || st.archived_at) throw new DomainError("not_found", 404);
      if (st.version !== p.expectedVersion)
        throw new DomainError("kiosk_settings_changed", 409);
      if (p.terminalId) {
        const [t] =
          await tx`select id from payment_terminals where id=${p.terminalId} and active and archived_at is null`;
        if (!t) throw new DomainError("payments_terminal_not_found", 404);
      }
      if (p.registerDeviceId) {
        const [d] =
          await tx`select id from devices where id=${p.registerDeviceId} and active`;
        if (!d) throw new DomainError("invalid_device", 400);
      }
      const [r] =
        await tx`update kiosk_stations set terminal_id=${p.terminalId},
        register_device_id=${p.registerDeviceId},version=version+1,updated_by=${s.employeeId},updated_at=now()
      where id=${stationId} returning version`;
      await audit(tx, s, "kiosk.station_saved", stationId, {
        terminalId: p.terminalId,
        registerDeviceId: p.registerDeviceId,
      });
      return { version: r.version as number };
    },
  );
}

/**
 * POST /api/kiosk/stations/:id/pairing (step-up; not once(): the reply carries the code). A new
 * 8-digit code valid 10 minutes, single use, killed by 5 wrong tries; it replaces the station's
 * live device (pending or paired: "Vincular tableta" re-pairs).
 */
export async function createPairing(tx: Tx, s: Session, stationId: string) {
  permit(s, managers);
  requireRecentAuth(s);
  id.parse(stationId);
  await tx`select id from restaurants where id=${s.tenantId} for share`;
  const [st] =
    await tx`select id,archived_at from kiosk_stations where id=${stationId} for share`;
  if (!st || st.archived_at) throw new DomainError("not_found", 404);
  await tx`update kiosk_devices set revoked_at=now(),revoked_by=${s.employeeId}
    where station_id=${stationId} and revoked_at is null`;
  const code = String(randomInt(0, 10 ** KIOSK_LIMITS.pairingDigits)).padStart(
    KIOSK_LIMITS.pairingDigits,
    "0",
  );
  const deviceId = randomUUID();
  const [d] =
    await tx`insert into kiosk_devices(tenant_id,id,station_id,pairing_code_hash,pairing_expires_at,created_by)
    values(${s.tenantId},${deviceId},${stationId},${pairingCodeHash(stationId, code)},
      now()+make_interval(mins=>${KIOSK_LIMITS.pairingMinutes}),${s.employeeId})
    returning pairing_expires_at`;
  await audit(tx, s, "kiosk.pairing_created", stationId, { deviceId });
  return {
    code,
    deviceId,
    expiresAt: (d.pairing_expires_at as Date).toISOString(),
  };
}

/** POST /api/kiosk/devices/:id/revoke ("Desvincular"; no PIN, like deactivating a code). */
export async function revokeKioskDevice(
  tx: Tx,
  s: Session,
  deviceId: string,
  raw: unknown,
) {
  permit(s, managers);
  id.parse(deviceId);
  const p = kioskRevokeDeviceInput.parse(raw);
  return once(
    tx,
    s,
    p.operationId,
    "kiosk.device.revoke",
    { deviceId },
    async () => {
      const [d0] =
        await tx`select station_id from kiosk_devices where id=${deviceId}`;
      if (!d0) throw new DomainError("not_found", 404);
      await tx`select id from kiosk_stations where id=${d0.station_id} for share`;
      const [d] =
        await tx`select revoked_at from kiosk_devices where id=${deviceId} for update`;
      if (!d.revoked_at)
        await tx`update kiosk_devices set revoked_at=now(),revoked_by=${s.employeeId} where id=${deviceId}`;
      await audit(tx, s, "kiosk.device_revoked", deviceId, {
        stationId: d0.station_id,
      });
      return { revoked: true };
    },
  );
}

/** GET /api/kiosk/suggestions: every curated set (the product editor and the cart setting). */
export async function listSuggestions(tx: Tx, s: Session) {
  permit(s, managers);
  const rows =
    await tx`select scope,source_product_id,product_ids,version from menu_suggestions`;
  return {
    cart: (() => {
      const c = rows.find((r) => r.scope === "cart");
      return {
        productIds: (c?.product_ids as string[]) ?? [],
        version: (c?.version as number) ?? 0,
      };
    })(),
    byProduct: Object.fromEntries(
      rows
        .filter((r) => r.scope === "product")
        .map((r) => [
          r.source_product_id as string,
          {
            productIds: r.product_ids as string[],
            version: r.version as number,
          },
        ]),
    ),
  };
}

/**
 * PUT /api/menu/products/:id/suggestions ("Sugerir con este producto", up to 4) and
 * PUT /api/kiosk/cart-suggestions ("Sugerencias del carrito", up to 6). Only public products
 * (no open price, not archived) other than the source; the row is replaced by UPDATE (R35).
 */
export async function saveSuggestions(
  tx: Tx,
  s: Session,
  sourceProductId: string | null,
  raw: unknown,
) {
  permit(s, managers);
  if (sourceProductId) id.parse(sourceProductId);
  const p = suggestionsInput.parse(raw);
  const scope = sourceProductId ? "product" : "cart";
  const max = sourceProductId
    ? KIOSK_LIMITS.productSuggestions
    : KIOSK_LIMITS.cartSuggestions;
  if (p.productIds.length > max) throw new DomainError("invalid_input");
  return once(
    tx,
    s,
    p.operationId,
    "kiosk.suggestions",
    { sourceProductId, ...p },
    async () => {
      await requireSelling(tx, s);
      await bumpMenuRevision(tx);
      const ids = [
        ...p.productIds,
        ...(sourceProductId ? [sourceProductId] : []),
      ];
      const docs = ids.length
        ? await tx<
            { data: Product }[]
          >`select data from catalog where id=any(${tx.array(ids)}::uuid[])`
        : [];
      const ok = new Set(
        docs
          .filter((d) => !d.data.archived && !d.data.openAmount)
          .map((d) => d.data.id),
      );
      if (sourceProductId && !docs.some((d) => d.data.id === sourceProductId))
        throw new DomainError("not_found", 404);
      if (p.productIds.some((x) => !ok.has(x) || x === sourceProductId))
        throw new DomainError("invalid_input");
      const [row] = sourceProductId
        ? await tx`select version from menu_suggestions where scope='product' and source_product_id=${sourceProductId} for update`
        : await tx`select version from menu_suggestions where scope='cart' for update`;
      if (((row?.version as number | undefined) ?? 0) !== p.expectedVersion)
        throw new DomainError("menu_changed", 409);
      const [r] = row
        ? sourceProductId
          ? await tx`update menu_suggestions set product_ids=${tx.array(p.productIds)}::uuid[],version=version+1,
                updated_at=now(),updated_by=${s.employeeId}
              where scope='product' and source_product_id=${sourceProductId} returning version`
          : await tx`update menu_suggestions set product_ids=${tx.array(p.productIds)}::uuid[],version=version+1,
                updated_at=now(),updated_by=${s.employeeId}
              where scope='cart' returning version`
        : await tx`insert into menu_suggestions(tenant_id,scope,source_product_id,product_ids,updated_by)
            values(${s.tenantId},${scope},${sourceProductId},${tx.array(p.productIds)}::uuid[],${s.employeeId})
            returning version`;
      await audit(
        tx,
        s,
        "menu.suggestions_saved",
        sourceProductId ?? s.tenantId,
        {
          scope,
          productIds: p.productIds,
        },
      );
      return { version: r.version as number, productIds: p.productIds };
    },
  );
}
