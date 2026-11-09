import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const omitted = new Set(["node_modules", "dist", ".git", ".state", ".private"]);
async function tests(directory = ".") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (omitted.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await tests(path)));
    else if (/(?:^|[/\\])test[/\\].+\.test\.ts$/.test(path)) paths.push(path);
  }
  return paths;
}
const paths = (await tests()).sort();
if (!paths.length) throw new Error("No test files found.");
const env = { ...process.env, BOUNTY_POOL_LIVE: "0", STUDYWINDOW_LIVE: "0" };
for (const key of [
  "TINYFISH_API_KEY",
  "TINYFISH_KEY_FILE",
  "BOUNTY_POOL_GRANT_FILE",
])
  delete env[key];
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=2", ...paths],
  {
    stdio: "inherit",
    env,
  },
);
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
