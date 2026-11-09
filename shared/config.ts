import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import { parseGrant, type AuthorizationGrant } from "./contracts.js";
import { ControlError } from "./errors.js";
import { PoolLedger, type Clock } from "./pool.js";

async function privateFile(
  path: string,
  missing: "AUTHORIZATION_REQUIRED" | "AUTHENTICATION",
): Promise<string> {
  if (!isAbsolute(path))
    throw new ControlError(
      missing,
      "Use an explicit absolute private file path.",
    );
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 20000)
      throw new Error("unsafe file");
    return await readFile(path, "utf8");
  } catch {
    throw new ControlError(
      missing,
      "The required private file is missing, oversized or not owner-only.",
    );
  }
}

export async function readGrantFile(path: string): Promise<AuthorizationGrant> {
  const text = await privateFile(path, "AUTHORIZATION_REQUIRED");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new ControlError(
      "INVALID_GRANT",
      "The private grant is not valid JSON.",
    );
  }
  return parseGrant(input);
}

/** Redacts routine inspection/serialization; only an explicit callback receives the header value. */
export class PrivateApiKey {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  withValue<T>(use: (value: string) => T): T {
    return use(this.#value);
  }
  toString(): string {
    return "[REDACTED]";
  }
  toJSON(): string {
    return "[REDACTED]";
  }
  [inspect.custom](): string {
    return "[PrivateApiKey REDACTED]";
  }
}

export async function loadControlsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  clock: Clock = Date.now,
): Promise<{ pool: PoolLedger; key: PrivateApiKey }> {
  if (env.BOUNTY_POOL_LIVE !== "1")
    throw new ControlError(
      "LIVE_DISABLED",
      "Live provider work is disabled by default.",
    );
  if (!env.BOUNTY_POOL_GRANT_FILE)
    throw new ControlError(
      "AUTHORIZATION_REQUIRED",
      "BOUNTY_POOL_GRANT_FILE is required.",
    );
  const grant = await readGrantFile(env.BOUNTY_POOL_GRANT_FILE);
  if (
    Date.parse(grant.authorized_at) > clock() + 5000 ||
    Date.parse(grant.expires_at) <= clock()
  )
    throw new ControlError(
      "AUTHORIZATION_REQUIRED",
      "The grant is not currently active.",
    );
  const pool = new PoolLedger(grant, clock);
  await pool.status(); // Missing/corrupt state never initializes a new allowance.
  if (!env.TINYFISH_KEY_FILE)
    throw new ControlError(
      "AUTHENTICATION",
      "TINYFISH_KEY_FILE must reference the existing private credential file.",
    );
  const text = await privateFile(env.TINYFISH_KEY_FILE, "AUTHENTICATION");
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /^TINYFISH_API_KEY=/.test(line));
  const value = lines[0]?.slice("TINYFISH_API_KEY=".length).trim();
  if (
    lines.length !== 1 ||
    !value ||
    !/^[\x21-\x7e]{16,512}$/.test(value) ||
    /^["']|["']$/.test(value) ||
    createHash("sha256").update(value).digest("hex") !== grant.key_sha256
  )
    throw new ControlError(
      "AUTHENTICATION",
      "The existing key file does not match the authorized pool identity.",
    );
  return { pool, key: new PrivateApiKey(value) };
}
