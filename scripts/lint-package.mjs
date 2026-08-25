import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const env = {
  ...process.env,
  npm_config_cache: fileURLToPath(new URL("../.npm-cache", import.meta.url)),
};
execFileSync("npx", ["publint"], { stdio: "inherit", env });
execFileSync(
  "npx",
  ["attw", "--pack", ".", "--ignore-rules", "cjs-resolves-to-esm"],
  { stdio: "inherit", env },
);
