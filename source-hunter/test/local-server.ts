import type { TestContext } from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function localServer(
  t: TestContext,
  options: { extensionId?: string; liveEnabled?: boolean } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BOUNTY_POOL_LIVE: options.liveEnabled ? "1" : "0",
    SOURCE_HUNTER_PORT: "0",
  };
  delete env.TINYFISH_API_KEY;
  delete env.TINYFISH_KEY_FILE;
  delete env.BOUNTY_POOL_GRANT_FILE;
  delete env.SOURCE_HUNTER_EXTENSION_ID;
  if (options.extensionId) env.SOURCE_HUNTER_EXTENSION_ID = options.extensionId;
  if (options.liveEnabled) {
    const missing = join(tmpdir(), "source-no-credentials-" + randomUUID());
    env.TINYFISH_KEY_FILE = join(missing, "missing.env");
    env.BOUNTY_POOL_GRANT_FILE = join(missing, "missing-grant.json");
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "source-hunter/src/server.ts"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    child.kill();
  });
  return await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Isolated Source Hunter server did not start within25 seconds.",
          ),
        ),
      25000,
    );
    timer.unref();
    child.stdout.on("data", (data) => {
      output += String(data);
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) {
        clearTimeout(timer);
        resolve(address);
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Isolated local server failed to start."));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Isolated local server exited before listening."));
    });
  });
}
