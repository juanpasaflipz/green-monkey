import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { shortlist } from "./candidates.ts";
import { INGREDIENTS, LINES, SUPPLIERS } from "./fixtures.ts";
import { matchLine, PREFILL_CONFIDENCE, type MatchResult } from "./match.ts";
import { toStockQuantity, type Conversion } from "./units.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SHORTLIST_SIZE = 8;
const CONCURRENCY = 4;

const dryRun = process.argv.includes("--dry-run");
const ingredientById = new Map(INGREDIENTS.map((i) => [i.id, i]));
const supplierById = new Map(SUPPLIERS.map((s) => [s.id, s]));
const nameOf = (id: string) => ingredientById.get(id)?.name ?? `— ${id} —`;

const work = LINES.map((line) => ({
  line,
  supplier: supplierById.get(line.supplierId)!,
  candidates: shortlist(line.text, INGREDIENTS, SHORTLIST_SIZE),
}));

const isCovered = (line: (typeof LINES)[number], ids: string[]) =>
  !ingredientById.has(line.expected) || ids.includes(line.expected);

if (dryRun) {
  for (const { line, supplier, candidates } of work) {
    const covered = isCovered(line, candidates.map((c) => c.ingredient.id));
    console.log(`\n${line.id} "${line.text}" ${line.quantity} ${line.unit} from ${supplier.name}`);
    console.log(`   expected: ${nameOf(line.expected)}${covered ? "" : " — NOT SHORTLISTED"}`);
    for (const c of candidates) console.log(`   ${c.similarity.toFixed(3)}  ${c.ingredient.name}`);
    const expectedIngredient = ingredientById.get(line.expected);
    if (expectedIngredient) {
      const conv = toStockQuantity(line.quantity, line.unit, line.text, expectedIngredient.stockUnit);
      console.log(`   conversion: ${conv.stockQuantity ?? "needs review"} ${expectedIngredient.stockUnit} (${conv.reason})`);
    }
  }
  process.exit(0);
}

try {
  process.loadEnvFile(resolve(here, "../../../.env"));
} catch {
  // Fall back to the existing environment.
}
const client = new TypeSafeClient();

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const results: MatchResult[] = await pool(work, CONCURRENCY, ({ line, supplier, candidates }) =>
  matchLine(client, line, supplier, candidates),
);

const rows = results.map((result, i) => {
  const { line } = work[i];
  const covered = isCovered(line, result.candidates.map((c) => c.ingredient.id));
  const answered = result.ingredientId ?? result.label;
  const correct = answered === line.expected;
  const ingredient = result.ingredientId ? ingredientById.get(result.ingredientId) : undefined;
  const conversion: Conversion | null = ingredient
    ? toStockQuantity(line.quantity, line.unit, line.text, ingredient.stockUnit)
    : null;
  const conversionCorrect =
    !correct || line.expectedStockQuantity === undefined || conversion?.stockQuantity === line.expectedStockQuantity;
  return { line, result, covered, correct, ingredient, conversion, conversionCorrect };
});

console.log(`\nModel: TypeSafe System One (default model), shortlist ${SHORTLIST_SIZE}, prefill ≥ ${PREFILL_CONFIDENCE}\n`);
for (const { line, result, covered, correct, ingredient, conversion, conversionCorrect } of rows) {
  const answer = result.ingredientId ? nameOf(result.ingredientId) : result.label;
  const stock = conversion
    ? conversion.stockQuantity === null
      ? "qty: needs review"
      : `qty: ${conversion.stockQuantity} ${ingredient!.stockUnit}`
    : "";
  console.log(
    `${correct ? "✓" : "✗"} ${line.id} ${line.text.padEnd(28)} → ${answer.padEnd(30)} ` +
      `conf ${result.confidence.toFixed(2)}  ${result.route.padEnd(22)} ${stock}` +
      (conversionCorrect ? "" : " [conversion mismatch]") +
      (correct ? "" : `  expected: ${nameOf(line.expected)}`) +
      (covered ? "" : " [not shortlisted]"),
  );
}

const byRoute = (route: MatchResult["route"]) => rows.filter((r) => r.result.route === route);
const summarize = (label: string, subset: typeof rows) =>
  console.log(`  ${label.padEnd(22)} ${subset.length.toString().padStart(2)} lines, ${subset.filter((r) => r.correct).length} correct`);

console.log("\nSummary");
summarize("all", rows);
summarize("prefill", byRoute("prefill"));
summarize("suggest_new", byRoute("suggest_new"));
summarize("suggest_not_inventory", byRoute("suggest_not_inventory"));
summarize("review", byRoute("review"));
console.log(`  shortlist coverage     ${rows.filter((r) => r.covered).length}/${rows.length}`);
const converted = rows.filter((r) => r.correct && r.conversion);
console.log(
  `  conversions            ${converted.filter((r) => r.conversionCorrect).length}/${converted.length} as expected, ` +
    `${converted.filter((r) => r.conversion!.stockQuantity === null).length} need operator entry`,
);

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const tokensIn = results.reduce((s, r) => s + r.inputTokens, 0);
const tokensOut = results.reduce((s, r) => s + r.outputTokens, 0);
console.log(`  tokens in/out          ${tokensIn}/${tokensOut}`);
console.log(`  latency ms             median ${latencies[Math.floor(latencies.length / 2)].toFixed(0)}, max ${latencies.at(-1)!.toFixed(0)}`);

const outDir = resolve(here, "../out");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "results.json");
writeFileSync(
  outFile,
  JSON.stringify(
    rows.map(({ line, result, covered, correct, conversion, conversionCorrect }) => ({
      line: { id: line.id, supplierId: line.supplierId, text: line.text, quantity: line.quantity, unit: line.unit, expected: line.expected, note: line.note },
      shortlist: result.candidates.map((c) => ({ id: c.ingredient.id, name: c.ingredient.name, similarity: c.similarity })),
      answer: { label: result.label, ingredientId: result.ingredientId, confidence: result.confidence, probabilities: result.probabilities },
      route: result.route,
      conversion,
      covered,
      correct,
      conversionCorrect,
      usage: { input: result.inputTokens, output: result.outputTokens },
      latencyMs: Math.round(result.latencyMs),
      requestId: result.requestId,
    })),
    null,
    2,
  ),
);
console.log(`\nWrote ${outFile}`);
