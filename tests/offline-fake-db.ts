/**
 * In-memory stand-in for the Dexie database in src/offline.ts, for unit tests
 * of the record builders, projections and sync loop. It implements only the
 * Dexie calls those modules make, with the same semantics that matter to them:
 * reads and writes are copies, `add` refuses an existing key, `update` with an
 * undefined value removes the field, and a transaction that throws leaves
 * every store as it was (atomic saves).
 */
type Row = { id: string } & Record<string, any>;
type Predicate = (row: Row) => boolean;

const copy = <T>(value: T): T => structuredClone(value);

export class FakeCollection {
  constructor(
    private readonly table: FakeTable,
    private readonly predicate: Predicate,
  ) {}
  filter(fn: (row: any) => boolean) {
    return new FakeCollection(
      this.table,
      (row) => this.predicate(row) && fn(copy(row)),
    );
  }
  private matching() {
    return [...this.table.rows.values()].filter(this.predicate);
  }
  async toArray() {
    this.table.valueReads += this.matching().length;
    return this.matching().map(copy);
  }
  async first() {
    return (await this.toArray())[0];
  }
  async count() {
    return this.matching().length;
  }
  async primaryKeys() {
    return this.matching().map((row) => row.id);
  }
  async delete() {
    const rows = this.matching();
    for (const row of rows) this.table.rows.delete(row.id);
    return rows.length;
  }
  async modify(changes: Record<string, unknown> | ((row: any) => void)) {
    const rows = this.matching();
    for (const row of rows)
      if (typeof changes === "function") changes(row);
      else Object.assign(row, copy(changes));
    return rows.length;
  }
}

export class FakeTable {
  rows = new Map<string, Row>();
  /** Rows whose values were read by a collection scan (storage-churn checks). */
  valueReads = 0;
  async get(id: string) {
    const row = this.rows.get(id);
    return row ? copy(row) : undefined;
  }
  async put(row: Row) {
    this.rows.set(row.id, copy(row));
    return row.id;
  }
  async add(row: Row) {
    if (this.rows.has(row.id)) {
      const error = new Error("Key already exists in the object store.");
      error.name = "ConstraintError";
      throw error;
    }
    this.rows.set(row.id, copy(row));
    return row.id;
  }
  async update(id: string, changes: Record<string, unknown>) {
    const row = this.rows.get(id);
    if (!row) return 0;
    for (const [key, value] of Object.entries(changes))
      if (value === undefined) delete row[key];
      else row[key] = copy(value);
    return 1;
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async bulkDelete(ids: string[]) {
    for (const id of ids) this.rows.delete(id);
  }
  async toArray() {
    this.valueReads += this.rows.size;
    return [...this.rows.values()].map(copy);
  }
  async count() {
    return this.rows.size;
  }
  where(index: string) {
    const by = (test: (value: any) => boolean) =>
      new FakeCollection(this, (row) => test(row[index]));
    return {
      equals: (value: unknown) => by((v) => v === value),
      startsWith: (prefix: string) =>
        by((v) => typeof v === "string" && v.startsWith(prefix)),
      anyOf: (values: unknown[]) => by((v) => values.includes(v)),
      below: (value: number) => by((v) => typeof v === "number" && v < value),
    };
  }
  filter(fn: (row: any) => boolean) {
    return new FakeCollection(this, (row) => fn(copy(row)));
  }
}

export class FakeDb {
  pending = new FakeTable();
  cache = new FakeTable();
  drafts = new FakeTable();
  private readonly tables = () => [this.pending, this.cache, this.drafts];
  /** Dexie's db.transaction(mode, ...tables, fn): all or nothing. */
  async transaction<T>(_mode: string, ...args: unknown[]): Promise<T> {
    const fn = args.at(-1) as () => Promise<T>;
    const before = this.tables().map(
      (table) => new Map([...table.rows].map(([key, row]) => [key, copy(row)])),
    );
    try {
      return await fn();
    } catch (e) {
      this.tables().forEach((table, i) => (table.rows = before[i]!));
      throw e;
    }
  }
  reset() {
    for (const table of this.tables()) {
      table.rows.clear();
      table.valueReads = 0;
    }
  }
}

export const fakeDb = new FakeDb();
