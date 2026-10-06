/**
 * cfdi advisory keys inside LO-3 (docs/ARCHITECTURE.md row 29, server/cfdi/locks.ts): per-ticket
 * keys (class 926), then document keys (927), then the global period key (928), never the reverse
 * in one transaction. The global ratchet (tests/lock-order.test.ts) sees all three as LO-3 area
 * keys and checks levels only; this check orders them inside the level (CFDI-R2-3, CFDI-R2-5).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { scanServer, scanSources, sqlEvents, type Node } from "./lock-scan.js";

const CLASSES = { 926: "ticket", 927: "document", 928: "period" } as const;

/** Steps back between cfdi key classes in one transaction (alternatives walked separately). */
function stepBacks(nodes: Node[]): string[] {
  const out: string[] = [];
  const walk = (list: Node[], max: number): number => {
    for (const n of list) {
      if ("tx" in n) {
        walk(n.tx, 0);
        continue;
      }
      if ("branch" in n) {
        max = Math.max(max, ...n.branch.map((alt) => walk(alt, max)));
        continue;
      }
      if ("call" in n) continue;
      const m = /^area:(92[678])$/.exec(n.event.object);
      if (!m) continue;
      const cls = Number(m[1]) as keyof typeof CLASSES;
      if (cls < max)
        out.push(
          `${CLASSES[max as keyof typeof CLASSES]} key then ${CLASSES[cls]} key via ${n.event.path.join(" > ")}`,
        );
      max = Math.max(max, cls);
    }
    return max;
  };
  walk(nodes, 0);
  return out;
}

describe("cfdi advisory keys (LO-3, row 29)", () => {
  it("each key has its own non-zero class, so the ratchet reads it as an LO-3 area key", () => {
    const source = readFileSync("server/cfdi/locks.ts", "utf8");
    const keys = [...source.matchAll(/await tx`([^`]+)`/g)].map((m) => m[1]);
    expect(keys).toHaveLength(3);
    expect(
      keys.map((k) => sqlEvents(k).map((e) => [e.object, e.label])),
    ).toEqual([
      [["area:926", "area key 926"]],
      [["area:927", "area key 927"]],
      [["area:928", "area key 928"]],
    ]);
  });

  it("no cfdi advisory key is taken outside server/cfdi/locks.ts", () => {
    const { program } = scanServer();
    const outside = program.units
      .filter((u) => u.file.startsWith("server/cfdi/"))
      .filter((u) => u.file !== "server/cfdi/locks.ts")
      .filter((u) =>
        /pg_advisory_xact_lock/.test(
          JSON.stringify(u.nodes.filter((n) => "event" in n)),
        ),
      )
      .map((u) => `${u.file}#${u.name}`);
    expect(outside).toEqual([]);
    for (const file of [
      "server/cfdi/service.ts",
      "server/cfdi/requests.ts",
      "server/cfdi/portal.ts",
      "server/cfdi/worker/global.ts",
      "server/cfdi/worker/reissue.ts",
    ])
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /pg_advisory_xact_lock/,
      );
  });

  it("every transaction takes ticket keys, then document keys, then the period key", () => {
    const { program } = scanServer();
    const found: string[] = [];
    let seen = 0;
    for (const unit of program.units) {
      const nodes = program.expand(unit);
      if (/area:92[678]/.test(JSON.stringify(nodes))) seen++;
      for (const v of stepBacks(nodes))
        found.push(`${unit.file}#${unit.name}: ${v}`);
    }
    expect(found).toEqual([]);
    // The units that take them: requests, cancellations, substitutions, the builder and reissue.
    expect(seen).toBeGreaterThanOrEqual(5);
  });

  it("the check sees a document key taken before a ticket key", () => {
    const files = new Map([
      ["server/cfdi/locks.ts", readFileSync("server/cfdi/locks.ts", "utf8")],
      [
        "server/cfdi/probe.ts",
        [
          'import { tenant } from "../db.js";',
          'import { lockDocument, lockTicket } from "./locks.js";',
          "export async function reversed(sql: any, t: string) {",
          "  await tenant(sql, t, async (tx: any) => {",
          '    await lockDocument(tx, t, "d");',
          '    await lockTicket(tx, t, "k");',
          "  });",
          "}",
        ].join("\n"),
      ],
    ]);
    const { program } = scanSources(files, new Set());
    const unit = program.units.find((u) => u.name === "reversed")!;
    expect(stepBacks(program.expand(unit))).toHaveLength(1);
  });
});
