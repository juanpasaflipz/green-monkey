import { CSV_BOM, CSV_EOL, csvCell as textCell } from "./csv.js";

/**
 * Owner data export (account 031, GAP-5): every public table with a tenant_id
 * column, discovered at request time, minus these tables and secret columns.
 * Contract for every area: name a secret column with a hash/secret/token/csrf
 * segment, or list it here.
 */
export const EXPORT_TABLE_DENYLIST: ReadonlySet<string> = new Set([
  // Security state, credentials and account-scoped rows (a tenant-only
  // export transaction would read them empty or expose credentials).
  "sessions",
  "operations",
  "offline_leases",
  "owner_browser_devices",
  "owner_memberships",
  "owner_location_commands",
  "restaurant_invitations",
  "signup_billing_intents",
  "billing_locations",
  "jobs",
  // Organization-scoped (app.organization_id): owners see them in the account
  // console; a tenant-only export transaction would read them empty.
  "support_actions",
  // cfdi 030: provider credential ciphertext, and the XML/PDF binaries (the
  // CFDI register offers its own downloads).
  "cfdi_secrets",
  "cfdi_files",
]);
/**
 * What the owner reads for each exportable table, [Spanish, English]: the
 * export picker never shows a raw table name (restaurant-day G3, FOH-16). The
 * value sent to the server and the CSV file name stay the table name. A new
 * tenant table needs a label here (tests/account-db.ts 29d checks every table
 * exportTables() returns).
 */
export const EXPORT_TABLE_LABELS: Readonly<
  Record<string, readonly [string, string]>
> = {
  audit: ["Bitácora", "Audit log"],
  business_day_settings: ["Día operativo", "Business day settings"],
  cash_count_reviews: [
    "Revisiones de diferencias de caja",
    "Cash difference reviews",
  ],
  cash_movements: ["Movimientos de caja", "Cash movements"],
  cash_sessions: [
    "Cajas (aperturas y cortes)",
    "Cash drawers (opening and close)",
  ],
  catalog: ["Catálogo de productos", "Product catalog"],
  cfdi_cancellations: ["Cancelaciones de CFDI", "CFDI cancellations"],
  cfdi_csd_uploads: [
    "Cargas de certificados (CSD)",
    "Certificate (CSD) uploads",
  ],
  cfdi_document_tickets: ["Tickets de cada CFDI", "Tickets of each CFDI"],
  cfdi_documents: ["Facturas (CFDI)", "Invoices (CFDI)"],
  cfdi_events: ["Eventos de facturación", "Invoicing events"],
  cfdi_global_periods: ["Periodos de factura global", "Global invoice periods"],
  cfdi_organizations: [
    "Organización emisora (CFDI)",
    "Issuing organization (CFDI)",
  ],
  cfdi_settings: ["Configuración de facturación", "Invoicing settings"],
  device_pairing_codes: ["Códigos de vinculación", "Pairing codes"],
  devices: ["Dispositivos", "Devices"],
  dining_areas: ["Áreas", "Dining areas"],
  dining_tables: ["Mesas", "Tables"],
  discount_allocations: ["Reparto de descuentos", "Discount allocations"],
  discounts: ["Descuentos", "Discounts"],
  employees: ["Equipo", "Staff"],
  expenses: ["Gastos", "Expenses"],
  fiscal_adjustments: [
    "Ajustes fiscales por reembolsos",
    "Fiscal refund adjustments",
  ],
  fiscal_folio_counters: ["Contadores de folio", "Folio counters"],
  fiscal_ticket_taxes: ["Impuestos de cada ticket", "Taxes of each ticket"],
  fiscal_tickets: ["Tickets con folio", "Folio tickets"],
  import_batches: ["Importaciones", "Imports"],
  kitchen_feed_versions: [
    "Versiones de la pantalla de cocina",
    "Kitchen display versions",
  ],
  line_voids: ["Anulaciones", "Voids"],
  loyalty_ledger: ["Movimientos del club de lealtad", "Loyalty club activity"],
  loyalty_members: ["Socios del club de lealtad", "Loyalty club members"],
  loyalty_order_links: [
    "Órdenes de socios del club",
    "Loyalty club member orders",
  ],
  loyalty_settings: [
    "Configuración del club de lealtad",
    "Loyalty club settings",
  ],
  menu_categories: ["Categorías del menú", "Menu categories"],
  menu_state: ["Estado del menú", "Menu state"],
  modifier_groups: ["Grupos de modificadores", "Modifier groups"],
  money_controls: [
    "Controles de descuentos y caja",
    "Discount and drawer controls",
  ],
  offline_archives: [
    "Ventas sin conexión archivadas",
    "Archived offline sales",
  ],
  offline_kitchen_reviews: [
    "Revisión en cocina de ventas sin conexión",
    "Kitchen review of offline sales",
  ],
  offline_lease_renewals: [
    "Renovaciones de venta sin conexión",
    "Offline selling renewals",
  ],
  offline_recoveries: [
    "Recuperaciones de ventas sin conexión",
    "Offline sale recoveries",
  ],
  offline_recovery_tasks: ["Tareas de recuperación", "Recovery tasks"],
  offline_sync_records: [
    "Sincronizaciones de ventas sin conexión",
    "Offline sale syncs",
  ],
  order_lines: ["Productos de las órdenes", "Order lines"],
  order_numbers: ["Números de orden", "Order numbers"],
  orders: ["Órdenes", "Orders"],
  pin_throttles: ["Intentos de PIN", "PIN attempts"],
  public_hold_numbers: ["Números de pedidos en línea", "Online order numbers"],
  public_links: ["Enlaces QR y kiosco", "QR and kiosk links"],
  public_order_holds: ["Pedidos en línea", "Online orders"],
  public_ordering_settings: [
    "Configuración de pedidos en línea",
    "Online ordering settings",
  ],
  receipts: ["Recibos", "Receipts"],
  recipe_versions: ["Recetas", "Recipes"],
  refund_batches: ["Reembolsos", "Refunds"],
  refund_lines: ["Productos reembolsados", "Refunded lines"],
  refund_units: ["Piezas reembolsadas", "Refunded units"],
  refunds: ["Reembolsos por forma de pago", "Refunds by payment"],
  report_prints: ["Cortes impresos", "Printed reports"],
  restaurant_account_settings: [
    "Privacidad del restaurante",
    "Restaurant privacy settings",
  ],
  restaurant_entitlements: ["Plan", "Plan"],
  restaurant_fiscal_profiles: ["Datos fiscales", "Fiscal profile"],
  rounds: ["Rondas", "Rounds"],
  shifts: ["Turnos", "Shifts"],
  source_mappings: ["Correspondencias de importación", "Import mappings"],
  stock_items: ["Insumos", "Stock items"],
  stock_movements: ["Movimientos de inventario", "Stock movements"],
  suppliers: ["Proveedores", "Suppliers"],
  tender_allocations: ["Reparto de pagos", "Payment allocations"],
  tenders: ["Pagos", "Payments"],
};

/** The owner-facing name of an exportable table (falls back to the name without underscores). */
export function exportTableLabel(name: string, locale: "es" | "en"): string {
  const label = EXPORT_TABLE_LABELS[name];
  return label ? label[locale === "en" ? 1 : 0] : name.replace(/_/g, " ");
}

/** Column names with one of these segments are never exported. */
export const EXPORT_COLUMN_DENY = /(^|_)(hash|secret|token|csrf)(_|$)/;
export { CSV_BOM };

/** Restaurant columns in the export header block (restaurants has no tenant_id). */
export const EXPORT_RESTAURANT_COLUMNS = [
  "id",
  "organization_id",
  "name",
  "currency",
  "timezone",
  "cutoff",
  "opening_days",
  "config_version",
  "free_location",
  "activation_pending",
  "negative_stock_policy",
  "offline_table_service",
] as const;

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
/**
 * One CSV cell of a raw table value: null/undefined → empty, Date → ISO, objects
 * and arrays → JSON, numbers (and numeric strings, as PostgreSQL sends numeric)
 * as they are; any other text goes through the shared OWASP guard (shared/csv.ts):
 * a leading = + - @ TAB CR LF gets an apostrophe, and commas, quotes and line
 * breaks are quoted.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object")
    return textCell(JSON.stringify(v, jsonReplacer), "t");
  const text = String(v);
  return PLAIN_NUMBER.test(text) ? text : textCell(text, "t");
}
/** Cells joined by commas, CRLF line end. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",") + CSV_EOL;
}
/** JSON.stringify replacer for exported rows: bigint as a string (the server adds binary handling). */
export function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

/** green-monkey-<slug>-<YYYYMMDD>.json / green-monkey-<slug>-<table>-<YYYYMMDD>.csv */
export function exportFilename(
  restaurantName: string,
  dateYmd: string,
  table?: string,
): string {
  const slug =
    restaurantName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "restaurante";
  const date = dateYmd.replace(/-/g, "");
  return table
    ? `green-monkey-${slug}-${table}-${date}.csv`
    : `green-monkey-${slug}-${date}.json`;
}
