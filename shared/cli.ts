import { readGrantFile } from "./config.js";
import { ControlError } from "./errors.js";
import { PoolLedger } from "./pool.js";

try {
  const [command, option, path, confirmOption, grantId] = process.argv.slice(2);
  if (
    !["status", "init"].includes(command ?? "") ||
    option !== "--grant" ||
    !path ||
    process.argv.slice(2).length !== (command === "init" ? 5 : 3) ||
    (command === "status" && confirmOption !== undefined) ||
    (command === "init" && (confirmOption !== "--confirm-grant" || !grantId))
  )
    throw new ControlError(
      "INVALID_REQUEST",
      "Usage: pool status --grant ABSOLUTE_FILE, or pool init --grant ABSOLUTE_FILE --confirm-grant UUID.",
    );
  const grant = await readGrantFile(path);
  const pool = new PoolLedger(grant);
  if (command === "init") {
    if (grantId !== grant.grant_id)
      throw new ControlError(
        "AUTHORIZATION_REQUIRED",
        "The initialization acknowledgement must match the external grant UUID.",
      );
    await pool.initialize();
  }
  console.log(JSON.stringify(await pool.status(), null, 2));
} catch (error) {
  const safe =
    error instanceof ControlError
      ? error
      : new ControlError(
          "STATE_FAILURE",
          "The pool command could not complete. No provider request was sent.",
        );
  console.error(
    JSON.stringify({
      ok: false,
      error: { code: safe.code, message: safe.message },
    }),
  );
  process.exitCode = 1;
}
