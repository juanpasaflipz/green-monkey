// POLISH-OPS-4 (LD-48): a browser spec that moves a restaurant's business-day cutoff on the
// reused local fixture database restores it from test.afterEach, not only from the test's
// finally: a timed-out test never reaches its finally, and global-setup puts the demo
// restaurants back in the seed's zone only before a run (tests/browser/global-setup.ts,
// CFDIFIX-R3-3), so a leftover 0 or 1439 would move the demo restaurant's rollover for every
// later test of the run.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CUTOFF_UPDATE = /update restaurants set cutoff\b/;

/** Top-level `async function name(...) {...}` blocks of a spec, by name. */
function topLevelFunctions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(
    /^(?:export )?async function (\w+)\([^]*?\n\}\n/gm,
  ))
    out.set(m[1], m[0]);
  return out;
}

describe("browser fixtures restore what they move (POLISH-OPS-4)", () => {
  const specs = readdirSync("tests/browser")
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => join("tests/browser", f));

  it("every spec that changes a restaurant's cutoff restores it from test.afterEach", () => {
    const moving = specs.filter((file) =>
      CUTOFF_UPDATE.test(readFileSync(file, "utf8")),
    );
    // The rollover spec is the one that moves it today.
    expect(moving).toContain("tests/browser/business-day.spec.ts");
    for (const file of moving) {
      const source = readFileSync(file, "utf8");
      const restorers = [...topLevelFunctions(source)]
        .filter(([, body]) => CUTOFF_UPDATE.test(body))
        .map(([name]) => name);
      expect(restorers, file).not.toEqual([]);
      const hooks = [...source.matchAll(/^test\.afterEach\(([^]*?)\);$/gm)].map(
        (m) => m[1],
      );
      expect(
        restorers.some((name) =>
          hooks.some((hook) => new RegExp(`\\b${name}\\(`).test(hook)),
        ),
        `${file}: test.afterEach calls one of ${restorers.join(", ")}`,
      ).toBe(true);
    }
  });
});
