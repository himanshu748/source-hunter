import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PoolLedger,
  readGrantFile,
  grantFingerprint,
  type AuthorizationGrant,
  type PricingQuote,
} from "../index.js";
import {
  MIGRATION_MARKER,
  nextTinySetGrant,
  stableJson,
} from "../migration.js";
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tinyset-migration-offline-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now(),
    clock = () => now;
  const grant: AuthorizationGrant = {
    version: 1,
    provider: "tinyfish",
    pool_id: "offline-policy-migration",
    grant_id: randomUUID(),
    authorized_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
    currency: "USD",
    max_reserved_microusd: 10000000,
    max_concurrent_operations: 2,
    state_directory: join(root, "pool"),
    key_sha256: createHash("sha256")
      .update("synthetic migration fingerprint only")
      .digest("hex"),
    allowed_bounties: ["funding-radar"],
    policies: [
      {
        id: "research-deep",
        unit: "run",
        max_units_per_operation: 1,
        max_unit_price_microusd: 2000000,
        max_operations: 3,
        max_active_operations: 2,
        enforcement: {
          mechanism: "fixed_request_contract",
          source_url: "https://docs.tinyfish.ai/research-api/reference",
          description: "Synthetic one-run Research policy.",
        },
      },
      {
        id: "tinyset-small",
        unit: "row",
        max_units_per_operation: 10,
        max_unit_price_microusd: 100000,
        max_operations: 2,
        max_active_operations: 2,
        enforcement: {
          mechanism: "fixed_request_contract",
          source_url: "https://docs.tinyfish.ai/datasets-api/reference",
          description: "Synthetic finite ten-row Set policy.",
        },
      },
      {
        id: "fetch-public",
        unit: "url",
        max_units_per_operation: 1,
        max_unit_price_microusd: 0,
        max_operations: 1000,
        max_active_operations: 2,
        enforcement: {
          mechanism: "fixed_request_contract",
          source_url: "https://docs.tinyfish.ai/fetch-api/reference",
          description: "Synthetic single-URL Fetch policy.",
        },
      },
    ],
  };
  const file = join(root, "grant.json");
  await writeFile(file, JSON.stringify(grant), { mode: 0o600 });
  const pool = new PoolLedger(grant, clock);
  await pool.initialize();
  const reserve = async (
    instance: PoolLedger,
    active: AuthorizationGrant,
    policyId: string,
  ) => {
    const p = active.policies.find((p) => p.id === policyId)!;
    const pricing: PricingQuote = {
      policy_id: p.id,
      currency: "USD",
      unit: p.unit,
      unit_price_microusd: p.max_unit_price_microusd,
      checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30000).toISOString(),
      evidence_url: "https://agent.tinyfish.ai/v1/wallet",
    };
    return instance.reserve({
      request_id: randomUUID(),
      bounty_id: "funding-radar",
      policy_id: p.id,
      pricing,
    });
  };
  for (const id of ["research-deep", "tinyset-small"]) {
    const r = await reserve(pool, grant, id);
    await pool.recordTerminal(r.id, "success", id === "research-deep" ? 1 : 5);
  }
  const fetch = await reserve(pool, grant, "fetch-public");
  await pool.recordUncertain(fetch.id);
  await pool.reconcileFixedFetchTerminalFailure({
    grant_id: grant.grant_id,
    reservation_id: fetch.id,
    request_id: fetch.request_id,
    policy_id: fetch.policy_id,
    http_status_class: "2xx",
    http_status: null,
    error_code: "RESPONSE_TOO_LARGE",
    evidence_sha256: "a".repeat(64),
  });
  return { root, grant, file, pool, clock, reserve };
}
test("explicit2→4 Set migration retains IDs, ceiling, key identity, all entries and prior recovery audit", async (t) => {
  const f = await fixture(t),
    before = JSON.parse(
      await readFile(join(f.grant.state_directory, "ledger.json"), "utf8"),
    ),
    statusBefore = await f.pool.status();
  const plan = await f.pool.prepareTinySetPolicyCountMigration(
    f.file,
    f.grant.grant_id,
  );
  await assert.rejects(f.pool.status());
  assert.equal(
    (await readGrantFile(f.file)).policies.find(
      (p) => p.id === "tinyset-small",
    )!.max_operations,
    2,
  );
  await f.pool.commitTinySetPolicyCountMigration(
    f.file,
    f.grant.grant_id,
    plan.id,
  );
  const grant = await readGrantFile(f.file),
    pool = new PoolLedger(grant, f.clock),
    status = await pool.status(),
    after = JSON.parse(
      await readFile(join(f.grant.state_directory, "ledger.json"), "utf8"),
    );
  assert.equal(grant.grant_id, f.grant.grant_id);
  assert.equal(grant.pool_id, f.grant.pool_id);
  assert.equal(grant.key_sha256, f.grant.key_sha256);
  assert.equal(grant.max_reserved_microusd, f.grant.max_reserved_microusd);
  assert.equal(
    grant.policies.find((p) => p.id === "tinyset-small")!.max_operations,
    4,
  );
  assert.equal(
    grant.policies.find((p) => p.id === "tinyset-small")!.enforcement
      .source_url,
    "https://docs.tinyfish.ai/datasets/reference.md",
  );
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.reconciliations, before.reconciliations);
  assert.equal(status.operations_used, statusBefore.operations_used);
  assert.equal(status.reserved_microusd, statusBefore.reserved_microusd);
  assert.equal(after.policy_migration.id, plan.id);
  assert.equal(after.grant_sha256, grantFingerprint(grant));
  await assert.rejects(f.pool.status());
  for (const id of [
    "tinyset-small",
    "tinyset-small",
    "tinyset-small",
    "research-deep",
    "research-deep",
  ]) {
    const r = await f.reserve(pool, grant, id);
    await pool.recordTerminal(r.id, "success", id === "tinyset-small" ? 10 : 1);
  }
  assert.equal((await pool.status()).reserved_microusd, 10000000);
  await assert.rejects(f.reserve(pool, grant, "tinyset-small"));
  await assert.rejects(f.reserve(pool, grant, "research-deep"));
  await assert.rejects(
    pool.prepareTinySetPolicyCountMigration(f.file, grant.grant_id),
  );
});
test("interruption after each of the three target writes stays fenced and explicitly resumes", async (t) => {
  for (const installed of [1, 2, 3]) {
    const f = await fixture(t),
      plan = await f.pool.prepareTinySetPolicyCountMigration(
        f.file,
        f.grant.grant_id,
      ),
      next = await readFile(
        join(plan.transaction_directory, "new-ledger.json"),
      );
    await writeFile(join(f.grant.state_directory, "ledger.json"), next, {
      mode: 0o600,
    });
    if (installed >= 2)
      await writeFile(
        join(f.grant.state_directory, "grant-binding.json"),
        await readFile(join(plan.transaction_directory, "new-binding.json")),
        { mode: 0o600 },
      );
    if (installed >= 3)
      await writeFile(
        f.file,
        await readFile(join(plan.transaction_directory, "new-grant.json")),
        { mode: 0o600 },
      );
    await assert.rejects(f.pool.status());
    await assert.rejects(f.reserve(f.pool, f.grant, "tinyset-small"));
    await f.pool.commitTinySetPolicyCountMigration(
      f.file,
      f.grant.grant_id,
      plan.id,
    );
    const grant = await readGrantFile(f.file);
    assert.equal(
      (await new PoolLedger(grant, f.clock).status()).reserved_microusd,
      3000000,
    );
    await assert.rejects(
      f.pool.commitTinySetPolicyCountMigration(
        f.file,
        f.grant.grant_id,
        plan.id,
      ),
    );
  }
});
test("unrelated grant changes, wrong acknowledgements and active operations cannot authorize migration", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.file);
  await assert.rejects(
    f.pool.prepareTinySetPolicyCountMigration(f.file, randomUUID()),
  );
  for (const mutate of [
    (g: AuthorizationGrant) => {
      g.policies[1]!.max_operations = 3;
    },
    (g: AuthorizationGrant) => {
      g.policies[1]!.max_units_per_operation = 11;
    },
    (g: AuthorizationGrant) => {
      g.policies[1]!.max_unit_price_microusd = 90000;
    },
  ]) {
    const grant = structuredClone(f.grant);
    mutate(grant);
    assert.throws(() => nextTinySetGrant(grant));
  }
  const active = await f.reserve(f.pool, f.grant, "tinyset-small");
  await assert.rejects(
    f.pool.prepareTinySetPolicyCountMigration(f.file, f.grant.grant_id),
  );
  assert.deepEqual(await readFile(f.file), before);
  await f.pool.cancelBeforeDispatch(active.id);
});
test("a prepared transaction refuses unexpected target edits without overwriting them", async (t) => {
  const f = await fixture(t),
    plan = await f.pool.prepareTinySetPolicyCountMigration(
      f.file,
      f.grant.grant_id,
    ),
    beforeLedger = await readFile(join(f.grant.state_directory, "ledger.json"));
  await writeFile(
    f.file,
    JSON.stringify({ ...f.grant, max_reserved_microusd: 9000000 }),
    { mode: 0o600 },
  );
  await assert.rejects(
    f.pool.commitTinySetPolicyCountMigration(f.file, f.grant.grant_id, plan.id),
  );
  assert.deepEqual(
    await readFile(join(f.grant.state_directory, "ledger.json")),
    beforeLedger,
  );
  assert.equal((await readGrantFile(f.file)).max_reserved_microusd, 9000000);
  assert.ok(await lstat(join(f.grant.state_directory, MIGRATION_MARKER)));
});
test("commit never steals a stale process lock or accepts another transaction ID", async (t) => {
  const f = await fixture(t),
    plan = await f.pool.prepareTinySetPolicyCountMigration(
      f.file,
      f.grant.grant_id,
    );
  await assert.rejects(
    f.pool.commitTinySetPolicyCountMigration(
      f.file,
      f.grant.grant_id,
      randomUUID(),
    ),
  );
  await mkdir(join(f.grant.state_directory, ".ledger.lock"));
  await assert.rejects(
    f.pool.commitTinySetPolicyCountMigration(f.file, f.grant.grant_id, plan.id),
  );
  assert.ok(await lstat(join(f.grant.state_directory, ".ledger.lock")));
  assert.equal(stableJson(await readGrantFile(f.file)), stableJson(f.grant));
});
