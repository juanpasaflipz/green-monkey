import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { previewImport } from "../shared/import.js";
const path = process.argv[2] ?? "tests/fixtures/pos-lite-catalog.json";
const input = await readFile(path, "utf8");
const report = {
  ...previewImport(JSON.parse(input)),
  fileHash: createHash("sha256").update(input).digest("hex"),
  mode: "dry-run",
  committed: false,
};
await mkdir("work/imports", { recursive: true });
await writeFile("work/imports/latest.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.rejected.length) process.exitCode = 2;
