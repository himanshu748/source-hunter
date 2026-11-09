import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PoolLedger,
  type AuthorizationGrant,
  type FixedFetchTerminalProof,
  type PricingQuote,
} from "../index.js";
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fetch-reconciliation-offline-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const grant: AuthorizationGrant = {
    version: 1,
    provider: "tinyfish",
    pool_id: "offline-reconciliation",
    grant_id: randomUUID(),
    authorized_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
    currency: "USD",
    max_reserved_microusd: 10000000,
    max_concurrent_operations: 2,
    state_directory: join(root, "pool"),
    key_sha256: createHash("sha256")
      .update("synthetic offline fingerprint only")
      .digest("hex"),
    allowed_bounties: ["funding-radar", "source-hunter"],
    policies: [
      {
        id: "fetch-public",
        unit: "url",
        max_units_per_operation: 1,
        max_unit_price_microusd: 2000,
        max_operations: 10,
        max_active_operations: 2,
        enforcement: {
          mechanism: "fixed_request_contract",
          source_url: "https://docs.tinyfish.ai/fetch-api/reference.md",
          description:
            "Synthetic single-URL fixed Fetch reconciliation fixture.",
        },
      },
      {
        id: "agent.other",
        unit: "step",
        max_units_per_operation: 2,
        max_unit_price_microusd: 16000,
        max_operations: 3,
        max_active_operations: 2,
        enforcement: {
          mechanism: "provider_cap",
          source_url: "https://docs.tinyfish.ai/",
          description:
            "Synthetic other job policy which cannot borrow Fetch recovery.",
        },
      },
    ],
  };
  const pool = new PoolLedger(grant, () => now);
  await pool.initialize();
  const reserve = (policyId = "fetch-public") => {
    const policy = grant.policies.find((p) => p.id === policyId)!;
    const pricing: PricingQuote = {
      policy_id: policyId,
      currency: "USD",
      unit: policy.unit,
      unit_price_microusd: policy.max_unit_price_microusd,
      checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30000).toISOString(),
      evidence_url: "https://agent.tinyfish.ai/v1/wallet",
    };
    return pool.reserve({
      request_id: randomUUID(),
      bounty_id: "funding-radar",
      policy_id: policyId,
      pricing,
    });
  };
  const proof = (
    entry: Awaited<ReturnType<typeof reserve>>,
  ): FixedFetchTerminalProof => ({
    grant_id: grant.grant_id,
    reservation_id: entry.id,
    request_id: entry.request_id,
    policy_id: entry.policy_id,
    http_status_class: "2xx",
    http_status: null,
    error_code: "RESPONSE_TOO_LARGE",
    evidence_sha256: createHash("sha256")
      .update("explicit synthetic operator-review artifact")
      .digest("hex"),
  });
  return { pool, grant, reserve, proof };
}
test("explicit reviewed fixed Fetch recovery retains every allowance/counter and appends a bound audit", async (t) => {
  const f = await fixture(t),
    entry = await f.reserve();
  await f.pool.recordUncertain(entry.id);
  const before = await f.pool.status();
  await f.pool.reconcileFixedFetchTerminalFailure(f.proof(entry));
  const after = await f.pool.status();
  assert.equal(after.halted, false);
  assert.equal(after.active_operations, 0);
  assert.equal(after.reserved_microusd, before.reserved_microusd);
  assert.equal(after.operations_used, before.operations_used);
  assert.equal(after.grant_id, before.grant_id);
  assert.equal(after.remaining_microusd, before.remaining_microusd);
  const ledger = JSON.parse(
    await readFile(join(f.grant.state_directory, "ledger.json"), "utf8"),
  );
  assert.equal(ledger.entries[0].accounted_units, 1);
  assert.equal(ledger.entries[0].outcome, "failure");
  assert.equal(
    ledger.reconciliations[0].evidence_sha256,
    f.proof(entry).evidence_sha256,
  );
  assert.equal(ledger.reconciliations[0].http_status, null);
  await assert.rejects(
    f.pool.reconcileFixedFetchTerminalFailure(f.proof(entry)),
  );
  assert.equal((await f.pool.status()).operations_used, 1);
});
test("recovery rejects mismatched identities, unsupported response proofs and uncertain non-Fetch jobs", async (t) => {
  const f = await fixture(t),
    entry = await f.reserve();
  await f.pool.recordUncertain(entry.id);
  const p = f.proof(entry);
  for (const proof of [
    { ...p, grant_id: randomUUID() },
    { ...p, request_id: randomUUID() },
    { ...p, http_status_class: "5xx" },
    { ...p, http_status: 500 },
    { ...p, error_code: "PROVIDER_TIMEOUT" },
  ])
    await assert.rejects(
      f.pool.reconcileFixedFetchTerminalFailure(
        proof as FixedFetchTerminalProof,
      ),
    );
  assert.equal((await f.pool.status()).halted, true);
  const g = await fixture(t),
    other = await g.reserve("agent.other");
  await g.pool.recordUncertain(other.id);
  await assert.rejects(
    g.pool.reconcileFixedFetchTerminalFailure(g.proof(other)),
  );
  assert.equal((await g.pool.status()).halted, true);
});
test("one recovered Fetch cannot unhalt another uncertain operation", async (t) => {
  const f = await fixture(t),
    a = await f.reserve(),
    b = await f.reserve("agent.other");
  await f.pool.recordUncertain(a.id);
  await f.pool.recordUncertain(b.id);
  await f.pool.reconcileFixedFetchTerminalFailure(f.proof(a));
  const status = await f.pool.status();
  assert.equal(status.halted, true);
  assert.equal(status.halt_reason, "remote_termination_unknown");
  assert.equal(status.active_operations, 1);
});
test("one recovered Fetch cannot clear a separate missing-accounting halt", async (t) => {
  const f = await fixture(t),
    a = await f.reserve(),
    b = await f.reserve("agent.other");
  await f.pool.recordTerminal(b.id, "failure");
  await f.pool.recordUncertain(a.id);
  await f.pool.reconcileFixedFetchTerminalFailure(f.proof(a));
  const status = await f.pool.status();
  assert.equal(status.halted, true);
  assert.equal(status.halt_reason, "accounting_unexpected");
});
