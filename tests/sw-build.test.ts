import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { swShellPlugin } from "../vite/sw-shell-plugin";

it("offline shell lists only emitted assets after shared CSS chunks are removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gm-sw-build-"));
  try {
    await Promise.all(Object.entries({
      "index.html": '<html><head></head><body><script type="module" src="/main.js"></script></body></html>',
      "main.js": 'window.openA = () => import("./a.js"); window.openB = () => import("./b.js");',
      "a.js": 'import "./shared.css"; export const a = "a";',
      "b.js": 'import "./shared.css"; export const b = "b";',
      "shared.css": 'body { color: green; }',
    }).map(([name, content]) => writeFile(join(root, name), content)));
    const result = await build({ configFile: false, root, logLevel: "silent", plugins: [swShellPlugin("fixture-build")], build: { write: false } });
    if (Array.isArray(result) || !("output" in result)) throw Error("unexpected build result");
    const files = new Set(result.output.map((item) => "/" + item.fileName));
    const worker = result.output.find((item) => item.fileName === "sw.js");
    if (!worker || worker.type !== "asset") throw Error("missing service worker");
    const match = String(worker.source).match(/const SHELL_ASSETS = (.*);/);
    const assets = JSON.parse(match![1]) as string[];
    expect(assets.some((asset) => asset.endsWith(".css"))).toBe(true);
    expect(assets.filter((asset) => !files.has(asset))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
