import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
assert.equal(packageJson.dependencies, undefined);
const esm = await import(new URL("dist/index.js", root));
const cjs = createRequire(import.meta.url)(
  fileURLToPath(new URL("dist/index.cjs", root)),
);
for (const api of [esm, cjs])
  assert.equal(
    api.reconcileTranscript([
      {
        role: "assistant",
        parts: [{ type: "tool-call", id: "x", name: "go", input: {} }],
      },
    ]).safeToReplay,
    true,
  );
const directory = mkdtempSync(join(tmpdir(), "agent-reconcile-"));
const fixture = join(directory, "history.json");
writeFileSync(
  fixture,
  JSON.stringify([
    {
      role: "assistant",
      parts: [{ type: "tool-call", id: "x", name: "go", input: {} }],
    },
  ]),
);
const cli = fileURLToPath(new URL("dist/cli.js", root));
assert.match(
  execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }),
  /^agent-reconcile/u,
);
assert.equal(
  execFileSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
  }).trim(),
  packageJson.version,
);
assert.match(
  execFileSync(process.execPath, [cli, fixture], { encoding: "utf8" }),
  /complete-pending/u,
);
let checkFailed = false;
try {
  execFileSync(process.execPath, [cli, fixture, "--check"], { stdio: "pipe" });
} catch (error) {
  checkFailed = error.status === 1;
}
assert.equal(checkFailed, true);
process.stdout.write(
  "ESM, CommonJS, canonical repair, CLI, and metadata verification passed.\n",
);
