/**
 * The fictional CI legal set and the local harness (account 031, LD-3, ACC-2).
 *
 * 1. One set of literals: server/legal-ci.ts (re-exported by
 *    tests/fixtures/legal-ci.ts) is canonical; the
 *    sourceable tests/fixtures/legal-ci.sh (scripts/compiled-local.sh), the
 *    commented lines of .env.example and both steps of qualification.yml that
 *    publish it must carry exactly the same values.
 * 2. DB and browser fixtures never depend on the process environment's legal
 *    configuration: every call to a legal-gated function whose last parameter
 *    defaults to legalConfig(process.env) passes an explicit configuration, so
 *    a local .env with the published set cannot turn a draft-document fixture
 *    into legal_acceptance_required. A static scan with the TypeScript
 *    compiler API (parse only).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { LEGAL_CI_ENV } from "./fixtures/legal-ci";

const read = (path: string) => readFileSync(path, "utf8");
const expected: Record<string, string> = { ...LEGAL_CI_ENV };

describe("the fictional CI legal set (LD-3)", () => {
  it("legal-ci.sh exports the same literals plus LEGAL_UNPUBLISHED_SIGNUP=allow, keeping values already set", () => {
    const exported = Object.fromEntries(
      [
        ...read("tests/fixtures/legal-ci.sh").matchAll(
          /^export ([A-Z_]+)="\$\{\1:-(.*)\}"$/gm,
        ),
      ].map((m) => [m[1], m[2]]),
    );
    expect(exported).toEqual({
      ...expected,
      LEGAL_UNPUBLISHED_SIGNUP: "allow",
    });
    // Every non-comment line is one of those exports (nothing else runs).
    const code = read("tests/fixtures/legal-ci.sh")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));
    expect(code).toHaveLength(Object.keys(exported).length);
  });

  it("scripts/compiled-local.sh sources it for the local compiled server", () => {
    expect(read("scripts/compiled-local.sh")).toMatch(
      /^source tests\/fixtures\/legal-ci\.sh$/m,
    );
  });

  it(".env.example documents it only as commented, test-only lines", () => {
    const example = read(".env.example");
    const commented = Object.fromEntries(
      [...example.matchAll(/^# ((?:LEGAL|SUPPORT)_[A-Z_]+)="(.*)"$/gm)].map(
        (m) => [m[1], m[2]],
      ),
    );
    expect(commented).toEqual(expected);
    expect(example).toMatch(/^# LEGAL_UNPUBLISHED_SIGNUP=allow$/m);
    expect(example).toMatch(/FICTIONAL set CI publishes/);
    // Never as live assignments: those stay empty.
    for (const name of Object.keys(expected))
      expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
  });

  it("qualification.yml publishes the same literals on the browser and account-http steps", () => {
    const workflow = read(".github/workflows/qualification.yml");
    const blocks = workflow
      .split(/\n\s+- name: /)
      .filter((step) => /LEGAL_ENTITY_NAME:/.test(step));
    expect(blocks.map((b) => b.split("\n", 1)[0])).toEqual([
      "Account HTTP checks",
      "Compiled browser acceptance (web + worker)",
    ]);
    for (const block of blocks) {
      const set = Object.fromEntries(
        [...block.matchAll(/^\s+((?:LEGAL|SUPPORT)_[A-Z_]+): "(.*)"$/gm)].map(
          (m) => [m[1], m[2]],
        ),
      );
      expect(set).toEqual(expected);
    }
  });
});

/** Legal-gated functions: a parameter defaulting to legalConfig(process.env). */
function gatedFunctions() {
  const gated = new Map<string, number>();
  for (const file of readdirSync("server").filter((f) => f.endsWith(".ts"))) {
    const path = join("server", file);
    const source = ts.createSourceFile(
      path,
      read(path),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements)
      if (ts.isFunctionDeclaration(statement) && statement.name)
        statement.parameters.forEach((parameter, index) => {
          if (
            parameter.initializer &&
            /^legalConfig\(process\.env\)$/.test(
              parameter.initializer.getText(source),
            )
          )
            gated.set(statement.name!.text, index);
        });
  }
  return gated;
}

describe("fixtures pass an explicit legal configuration (ACC-2)", () => {
  it("finds the legal-gated functions", () => {
    const gated = gatedFunctions();
    for (const name of [
      "createOwnerRestaurant",
      "createAdditionalLocation",
      "createInvitation",
      "acceptInvitation",
      "selectFreeLocation",
      "createCoOwnerInvitation",
      "requestTransfer",
      "acceptTransfer",
    ])
      expect(gated.has(name), name).toBe(true);
  });

  it("no DB, HTTP or browser fixture leaves one to the process environment", () => {
    const gated = gatedFunctions();
    const files = [
      ...readdirSync("tests")
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join("tests", f)),
      ...readdirSync("tests/browser")
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("tests/browser", f)),
    ];
    const implicit: string[] = [];
    let calls = 0;
    for (const path of files) {
      const source = ts.createSourceFile(
        path,
        read(path),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          gated.has(node.expression.text)
        ) {
          calls++;
          if (node.arguments.length <= gated.get(node.expression.text)!) {
            const { line } = source.getLineAndCharacterOfPosition(
              node.getStart(source),
            );
            implicit.push(`${path}:${line + 1} ${node.expression.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(calls).toBeGreaterThan(50);
    expect(implicit).toEqual([]);
  });
});
