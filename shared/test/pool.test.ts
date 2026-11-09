import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PoolLedger,
  loadControlsFromEnvironment,
  parseGrant,
  type AuthorizationGrant,
  type PricingQuote,
} from "../index.js";

const material = "synthetic-offline-credential-material-only";
const cost = 24 * 16000;
const errorCode = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  assert.ok(error instanceof Error);
  assert.ok(!error.message.includes(material));
  return true;
};
async function fixture(t: TestContext, budget = 10000000) {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), "bounty-pool-offline-")),
  );
  t.after(() => rm(path, { recursive: true, force: true }));
  const now = Date.now(),
    clock = () => now;
  const grant: AuthorizationGrant = {
    version: 1,
    provider: "tinyfish",
    pool_id: "offline-test-pool",
    grant_id: randomUUID(),
    authorized_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
    currency: "USD",
    max_reserved_microusd: budget,
    max_concurrent_operations: 2,
    state_directory: join(path, "state"),
    key_sha256: createHash("sha256").update(material).digest("hex"),
    allowed_bounties: ["zombie-check", "funding-radar"],
    policies: [
      {
        id: "offline.agent",
        unit: "step",
        max_units_per_operation: 24,
        max_unit_price_microusd: 16000,
        max_operations: 20,
        max_active_operations: 2,
        enforcement: {
          mechanism: "provider_cap",
          source_url: "https://docs.tinyfish.ai/",
          description:
            "Synthetic test-only policy; not verified provider configuration.",
        },
      },
    ],
  };
  const quote: PricingQuote = {
    policy_id: "offline.agent",
    currency: "USD",
    unit: "step",
    unit_price_microusd: 16000,
    checked_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60000).toISOString(),
    evidence_url: "https://agent.tinyfish.ai/v1/wallet",
  };
  const pool = new PoolLedger(grant, clock);
  const request = (bounty = "zombie-check") => ({
    request_id: randomUUID(),
    bounty_id: bounty,
    policy_id: "offline.agent",
    pricing: quote,
  });
  return { path, now, clock, grant, quote, pool, request };
}

test("normal reads and reservations never initialize missing state; explicit initialization cannot overwrite", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.pool.status(), errorCode("STATE_FAILURE"));
  await assert.rejects(f.pool.reserve(f.request()), errorCode("STATE_FAILURE"));
  await f.pool.initialize();
  const file = join(f.grant.state_directory, "ledger.json");
  const before = await readFile(file, "utf8");
  await assert.rejects(f.pool.initialize(), errorCode("STATE_FAILURE"));
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await f.pool.status()).reserved_microusd, 0);
});

test("transports read immutable bounds from the bound grant rather than caller-supplied caps", async (t) => {
  const f = await fixture(t);
  const policy = f.pool.policyBounds("offline.agent");
  assert.equal(policy.max_units_per_operation, 24);
  assert.equal(Reflect.set(policy, "max_units_per_operation", 250), false);
  assert.equal(
    Reflect.set(policy.enforcement, "source_url", "https://evil.example"),
    false,
  );
  assert.notEqual(f.pool.policyBounds("offline.agent"), policy);
  assert.equal(
    f.pool.policyBounds("offline.agent").max_units_per_operation,
    24,
  );
  assert.throws(
    () => f.pool.policyBounds("unknown.policy"),
    errorCode("INVALID_REQUEST"),
  );
});

test("a persistent grant binding prevents reinitialization after ledger loss", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const bindingPath = join(f.grant.state_directory, "grant-binding.json");
  const binding = await readFile(bindingPath, "utf8");
  await unlink(join(f.grant.state_directory, "ledger.json"));
  await assert.rejects(f.pool.initialize(), errorCode("STATE_FAILURE"));
  await assert.rejects(f.pool.reserve(f.request()), errorCode("STATE_FAILURE"));
  await assert.rejects(f.pool.status(), errorCode("STATE_FAILURE"));
  assert.equal(await readFile(bindingPath, "utf8"), binding);
});

test("separate instances share one aggregate allowance across bounties without refunds", async (t) => {
  const f = await fixture(t, 500000);
  await f.pool.initialize();
  const one = await f.pool.reserve(f.request());
  await f.pool.markStarted(one.id, randomUUID());
  await f.pool.recordTerminal(one.id, "failure", 2);
  const other = new PoolLedger(f.grant, f.clock);
  await assert.rejects(
    other.reserve(f.request("funding-radar")),
    errorCode("ALLOWANCE_EXHAUSTED"),
  );
  const state = await other.status();
  assert.equal(state.reserved_microusd, cost);
  assert.equal(state.active_operations, 0);
  assert.equal(state.by_bounty["zombie-check"]?.reserved_microusd, cost);
  assert.equal(state.by_bounty["funding-radar"]?.reserved_microusd, 0);
});

test("independent Node processes reserve against the same filesystem lock and ledger", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const file = join(f.path, "grant.json");
  await writeFile(file, JSON.stringify(f.grant), { mode: 0o600 });
  const script = `
    import {randomUUID} from 'node:crypto';
    import {readGrantFile,PoolLedger} from './shared/index.ts';
    const grant=await readGrantFile(process.argv[1]);
    const pool=new PoolLedger(grant);
    const now=Date.now();
    try {
      const r=await pool.reserve({request_id:randomUUID(),bounty_id:'zombie-check',policy_id:'offline.agent',pricing:{
        policy_id:'offline.agent',currency:'USD',unit:'step',unit_price_microusd:16000,
        checked_at:new Date(now).toISOString(),expires_at:new Date(now+60000).toISOString(),evidence_url:'https://agent.tinyfish.ai/v1/wallet'
      }});
      console.log(JSON.stringify({ok:true,id:r.id}));
    } catch(e) {console.log(JSON.stringify({ok:false,code:e.code}));}
  `;
  const results = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const r = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script, file],
        { cwd: process.cwd() },
      );
      return JSON.parse(r.stdout) as {
        ok: boolean;
        id?: string;
        code?: string;
      };
    }),
  );
  const granted = results.filter((r) => r.ok);
  assert.ok(granted.length >= 1 && granted.length <= 2);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "BUSY"));
  assert.equal(
    (await f.pool.status()).reserved_microusd,
    granted.length * cost,
  );
});

test("zero-priced operations still consume a bounded endpoint count", async (t) => {
  const f = await fixture(t);
  const grant = {
    ...f.grant,
    max_reserved_microusd: 0,
    policies: [
      {
        ...f.grant.policies[0]!,
        max_unit_price_microusd: 0,
        max_operations: 2,
      },
    ],
  };
  const pool = new PoolLedger(grant, f.clock);
  await pool.initialize();
  const pricing = { ...f.quote, unit_price_microusd: 0 };
  for (let n = 0; n < 2; n++) {
    const r = await pool.reserve({ ...f.request(), pricing });
    await pool.cancelBeforeDispatch(r.id);
  }
  await assert.rejects(
    pool.reserve({ ...f.request(), pricing }),
    errorCode("ALLOWANCE_EXHAUSTED"),
  );
  assert.equal((await pool.status()).reserved_microusd, 0);
  assert.equal((await pool.status()).operations_used, 2);
});

test("a stricter endpoint concurrency limit applies inside a larger aggregate pool", async (t) => {
  const f = await fixture(t);
  const grant = {
    ...f.grant,
    policies: [{ ...f.grant.policies[0]!, max_active_operations: 1 }],
  };
  const pool = new PoolLedger(grant, f.clock);
  await pool.initialize();
  await pool.reserve(f.request());
  await assert.rejects(
    pool.reserve(f.request("funding-radar")),
    errorCode("BUSY"),
  );
  assert.equal((await pool.status()).active_operations, 1);
});

test("concurrent reservations are serialized and cannot overrun the shared concurrency bound", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      new PoolLedger(f.grant, f.clock).reserve(f.request()),
    ),
  );
  const granted = results.filter((r) => r.status === "fulfilled");
  assert.ok(granted.length >= 1 && granted.length <= 2);
  assert.ok(
    results
      .filter((r) => r.status === "rejected")
      .every((r) => r.reason.code === "BUSY"),
  );
  const state = await f.pool.status();
  assert.equal(state.active_operations, granted.length);
  assert.equal(state.reserved_microusd, granted.length * cost);
  for (const result of granted)
    await f.pool.cancelBeforeDispatch(result.value.id);
  assert.equal((await f.pool.status()).active_operations, 0);
  assert.equal(
    (await f.pool.status()).reserved_microusd,
    granted.length * cost,
  );
});

test("duplicate request identities cannot launch a second paid attempt, even after terminal failure", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const input = f.request();
  const reservation = await f.pool.reserve(input);
  await f.pool.recordTerminal(reservation.id, "failure", 0);
  await assert.rejects(f.pool.reserve(input), errorCode("DUPLICATE_OPERATION"));
  assert.equal((await f.pool.status()).operations_used, 1);
});

test("known terminal cancellation retains its full reservation; uncertain termination halts the entire pool", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const cancelled = await f.pool.reserve(f.request());
  await f.pool.markStarted(cancelled.id, randomUUID());
  await assert.rejects(
    f.pool.cancelBeforeDispatch(cancelled.id),
    errorCode("STATE_FAILURE"),
  );
  await f.pool.recordTerminal(cancelled.id, "cancelled", 3);
  const uncertain = await f.pool.reserve(f.request("funding-radar"));
  await f.pool.markStarted(uncertain.id, randomUUID());
  await f.pool.recordUncertain(uncertain.id);
  const state = await f.pool.status();
  assert.equal(state.reserved_microusd, cost * 2);
  assert.equal(state.active_operations, 1);
  assert.equal(state.halt_reason, "remote_termination_unknown");
  await assert.rejects(f.pool.reserve(f.request()), errorCode("HALTED"));
});

test("cancelled signals reject before spending a reservation", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.pool.reserve(f.request(), controller.signal),
    errorCode("CANCELLED"),
  );
  assert.equal((await f.pool.status()).operations_used, 0);
});

test("missing or excessive terminal accounting blocks later work without releasing ceilings", async (t) => {
  for (const units of [undefined, 25]) {
    const f = await fixture(t);
    await f.pool.initialize();
    const reservation = await f.pool.reserve(f.request());
    await f.pool.markStarted(reservation.id, randomUUID());
    await f.pool.recordTerminal(reservation.id, "success", units);
    const state = await f.pool.status();
    assert.equal(state.halt_reason, "accounting_unexpected");
    assert.equal(state.reserved_microusd, cost);
    await assert.rejects(f.pool.reserve(f.request()), errorCode("HALTED"));
  }
});

test("stale, future, mismatched and increased pricing rejects before a ledger write; a discount does not shrink reservations", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const file = join(f.grant.state_directory, "ledger.json");
  const before = await readFile(file, "utf8");
  const cases: Array<[unknown, string]> = [
    [{ ...f.quote, unit_price_microusd: 16001 }, "PRICING_CHANGED"],
    [
      { ...f.quote, checked_at: new Date(f.now - 61000).toISOString() },
      "PRICING_STALE",
    ],
    [
      { ...f.quote, checked_at: new Date(f.now + 6000).toISOString() },
      "PRICING_STALE",
    ],
    [
      { ...f.quote, expires_at: new Date(f.now + 300001).toISOString() },
      "PRICING_STALE",
    ],
    [{ ...f.quote, unit: "other" }, "INVALID_REQUEST"],
    [{ ...f.quote, currency: "EUR" }, "INVALID_REQUEST"],
    [
      { ...f.quote, evidence_url: "https://evil.example/prices" },
      "INVALID_REQUEST",
    ],
  ];
  for (const [pricing, expected] of cases) {
    await assert.rejects(
      f.pool.reserve({ ...f.request(), pricing }),
      errorCode(expected),
    );
    assert.equal(await readFile(file, "utf8"), before);
  }
  await f.pool.reserve({
    ...f.request(),
    pricing: { ...f.quote, unit_price_microusd: 1 },
  });
  assert.equal((await f.pool.status()).reserved_microusd, cost);
});

test("grant identity, budget, key identity and endpoint rules cannot be silently substituted", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  for (const change of [
    { grant_id: randomUUID() },
    { max_reserved_microusd: 11000000 },
    { key_sha256: "a".repeat(64) },
    { allowed_bounties: ["zombie-check"] },
  ])
    await assert.rejects(
      new PoolLedger({ ...f.grant, ...change }, f.clock).status(),
      errorCode("STATE_FAILURE"),
    );
  const path = join(f.path, "other");
  await mkdir(path, { mode: 0o700 });
  await assert.rejects(
    new PoolLedger({ ...f.grant, state_directory: path }, f.clock).reserve(
      f.request(),
    ),
    errorCode("STATE_FAILURE"),
  );
  assert.equal((await f.pool.status()).operations_used, 0);
});

test("corrupt totals and stale locks fail closed and are not automatically repaired", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const file = join(f.grant.state_directory, "ledger.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  data.reserved_microusd = 1;
  await writeFile(file, JSON.stringify(data));
  const corrupted = await readFile(file, "utf8");
  await assert.rejects(f.pool.reserve(f.request()), errorCode("STATE_FAILURE"));
  assert.equal(await readFile(file, "utf8"), corrupted);
  await mkdir(join(f.grant.state_directory, ".ledger.lock"), { mode: 0o700 });
  await assert.rejects(f.pool.status(), errorCode("BUSY"));
});

test("credentials and connection URLs cannot be stored as provider identifiers", async (t) => {
  const f = await fixture(t);
  await f.pool.initialize();
  const reservation = await f.pool.reserve(f.request());
  for (const reference of [
    material,
    "wss://private.example/connection",
    "sk-test-secret-material-not-a-job",
  ])
    await assert.rejects(
      f.pool.markStarted(reservation.id, reference),
      errorCode("INVALID_REQUEST"),
    );
  assert.ok(
    !(
      await readFile(join(f.grant.state_directory, "ledger.json"), "utf8")
    ).includes(material),
  );
});

test("runtime controls default off and require a private grant, matching ledger and matching owner-only key file", async (t) => {
  await assert.rejects(
    loadControlsFromEnvironment({}),
    errorCode("LIVE_DISABLED"),
  );
  await assert.rejects(
    loadControlsFromEnvironment({ BOUNTY_POOL_LIVE: "1" }),
    errorCode("AUTHORIZATION_REQUIRED"),
  );
  const f = await fixture(t);
  await f.pool.initialize();
  const grantFile = join(f.path, "grant.json"),
    keyFile = join(f.path, "credentials.env");
  await writeFile(grantFile, JSON.stringify(f.grant), { mode: 0o600 });
  await writeFile(
    keyFile,
    "TINYFISH_API_KEY=" + material + "\nSTUDYWINDOW_LIVE=1\n",
    { mode: 0o600 },
  );
  const env = {
    BOUNTY_POOL_LIVE: "1",
    BOUNTY_POOL_GRANT_FILE: grantFile,
    TINYFISH_KEY_FILE: keyFile,
  };
  const controls = await loadControlsFromEnvironment(env, f.clock);
  assert.ok(!JSON.stringify(controls).includes(material));
  assert.ok(!inspect(controls).includes(material));
  assert.equal(
    controls.key.withValue((value) =>
      createHash("sha256").update(value).digest("hex"),
    ),
    f.grant.key_sha256,
  );
  await chmod(keyFile, 0o644);
  await assert.rejects(
    loadControlsFromEnvironment(env, f.clock),
    errorCode("AUTHENTICATION"),
  );
  await chmod(keyFile, 0o600);
  await writeFile(keyFile, "TINYFISH_API_KEY=different-synthetic-material\n");
  await assert.rejects(
    loadControlsFromEnvironment(env, f.clock),
    errorCode("AUTHENTICATION"),
  );
});

test("malformed, overflowing and expired grants never authorize live work", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { state_directory: "./relative" },
    { max_reserved_microusd: -1 },
    { max_reserved_microusd: 1.5 },
    { allowed_bounties: ["zombie-check", "zombie-check"] },
    {
      policies: [
        {
          ...f.grant.policies[0]!,
          max_units_per_operation: 100000000,
          max_unit_price_microusd: 1000000000,
        },
      ],
    },
  ])
    assert.throws(
      () => parseGrant({ ...f.grant, ...change }),
      errorCode("INVALID_GRANT"),
    );
  const expired = new PoolLedger(
    { ...f.grant, expires_at: new Date(f.now - 500).toISOString() },
    f.clock,
  );
  await assert.rejects(
    expired.initialize(),
    errorCode("AUTHORIZATION_REQUIRED"),
  );
});

test("operator CLI reports safe missing-grant failure rather than initializing state or reading a key", async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "shared/cli.ts",
        "status",
        "--grant",
        "/nonexistent/bounty-grant.json",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOUNTY_POOL_LIVE: "0" },
      },
    ),
    (error: unknown) => {
      const output = (error as { stderr: string }).stderr;
      assert.equal(JSON.parse(output).error.code, "AUTHORIZATION_REQUIRED");
      assert.ok(!output.includes(material));
      return true;
    },
  );
});
