import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every source file under a directory (recursive). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

/** The argument text of each `.cursor(` call in a source file (comments skipped). */
function cursorCalls(text: string): string[] {
  const source = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const calls: string[] = [];
  for (const m of source.matchAll(/\.cursor\(/g)) {
    let depth = 1,
      i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth; i++)
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    calls.push(source.slice(start, i - 1));
  }
  return calls;
}

describe("postgres.js cursors (W3-2 flake, LD-42)", () => {
  it("the scanner tells the iterator form from the callback form", () => {
    expect(
      cursorCalls("for await (const rows of tx`x`.cursor(\n  500,\n)) {}"),
    ).toEqual(["\n  500,\n"]);
    expect(
      cursorCalls("await tx`x`.cursor(500, async (rows) => { f(g(rows)); })"),
    ).toEqual(["500, async (rows) => { f(g(rows)); }"]);
    expect(
      cursorCalls("/** a `.cursor(n, fn)` callback */\n// .cursor(fn)"),
    ).toEqual([]);
  });

  it("server/ and scripts/ only use the async-iterator form: postgres 3.4.8 neither awaits nor catches a .cursor(n, fn) callback on a query's final batch", () => {
    const offenders = ["server", "scripts"].flatMap(sources).flatMap((file) =>
      cursorCalls(readFileSync(file, "utf8"))
        .filter((args) => !/^[\w.$]*,?$/.test(args.replace(/\s/g, "")))
        .map((args) => `${file}: .cursor(${args.trim().slice(0, 60)}`),
    );
    expect(offenders).toEqual([]);
  });
});
