#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import process from "node:process";
import { createRequire } from "node:module";
import { reconcileProvider, type Provider } from "./adapters.js";
import { reconcileTranscript } from "./reconcile.js";
import type { AgentMessage, PendingPolicy } from "./types.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const HELP = `agent-reconcile [file|-] [options]

Repair interrupted AI agent tool-call histories and print the result as JSON.

Options:
  --provider <canonical|openai|anthropic|gemini|ai-sdk>
  --pending <error|remove|keep>  Policy for unresolved calls (default: error)
  --check                        Exit 1 when repairs are required or replay is unsafe
  --pretty                       Pretty-print JSON
  --max-bytes <n>                Input limit (default: 67108864)
  --help                         Show help
  --version                      Show version
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write(`${packageJson.version}\n`);
  process.exit(0);
}

let file = "-";
let provider: Provider | "canonical" = "canonical";
let pending: PendingPolicy = "error";
let check = false;
let pretty = false;
let maxBytes = 64 * 1024 * 1024;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--provider") {
    const value = args[++index];
    if (
      !value ||
      !["canonical", "openai", "anthropic", "gemini", "ai-sdk"].includes(value)
    )
      fail("Invalid --provider value.");
    provider = value as Provider | "canonical";
  } else if (arg === "--pending") {
    const value = args[++index];
    if (!value || !["error", "remove", "keep"].includes(value))
      fail("Invalid --pending value.");
    pending = value as PendingPolicy;
  } else if (arg === "--max-bytes") {
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 0)
      fail("--max-bytes must be a non-negative safe integer.");
    maxBytes = value;
  } else if (arg === "--check") check = true;
  else if (arg === "--pretty") pretty = true;
  else if (arg?.startsWith("-")) {
    if (arg !== "-") fail(`Unknown option: ${arg}`);
    else file = arg;
  } else if (arg) file = arg;
}

let source: string;
if (file === "-") {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes)
      fail(`Input exceeds --max-bytes (${String(maxBytes)}).`);
    chunks.push(buffer);
  }
  source = Buffer.concat(chunks).toString("utf8");
} else {
  if (statSync(file).size > maxBytes)
    fail(`Input exceeds --max-bytes (${String(maxBytes)}).`);
  source = readFileSync(file, "utf8");
}
let parsed: unknown;
try {
  parsed = JSON.parse(source) as unknown;
} catch (error) {
  fail(
    `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (!Array.isArray(parsed)) fail("Input must be a JSON array of messages.");
const result =
  provider === "canonical"
    ? reconcileTranscript(parsed as AgentMessage[], { pending })
    : reconcileProvider(provider, parsed, { pending });
process.stdout.write(`${JSON.stringify(result, null, pretty ? 2 : 0)}\n`);
if (check && (result.changed || !result.safeToReplay)) process.exit(1);
