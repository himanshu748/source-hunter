import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PoolLedger,
  PrivateApiKey,
  type AuthorizationGrant,
} from "../../shared/index.js";
import { runDeepResearch } from "../research.js";
const material = "synthetic-research-offline-only";
async function setup(
  t: TestContext,
  handler: (path: string, method: string) => Response | Promise<Response>,
) {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), "research-offline-")),
  );
  t.after(() => rm(path, { recursive: true, force: true }));
  const now = Date.now();
  const grant: AuthorizationGrant = {
    version: 1,
    provider: "tinyfish",
    pool_id: "offline-research",
    grant_id: randomUUID(),
    authorized_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
    currency: "USD",
    max_reserved_microusd: 10000000,
    max_concurrent_operations: 2,
    state_directory: join(path, "state"),
    key_sha256: createHash("sha256").update(material).digest("hex"),
    allowed_bounties: ["source-hunter", "compliance-map"],
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
          description: "Synthetic Deep single-run policy for offline tests.",
        },
      },
    ],
  };
  const pool = new PoolLedger(grant);
  await pool.initialize();
  const calls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname,
      method = options?.method ?? "GET";
    calls.push(method + " " + path);
    if (path === "/v1/wallet")
      return Response.json({
        available_balance: "10",
        currency: "USD",
        rates: {
          meters: [
            {
              label: "TinyFish Research (Deep)",
              unit_amount: "2",
              currency: "USD",
              per: "run",
            },
          ],
        },
      });
    if (path.endsWith("run-research-async"))
      assert.deepEqual(JSON.parse(String(options?.body)).mode, "deep");
    return handler(path, method);
  };
  return {
    controls: { pool, key: new PrivateApiKey(material) },
    request,
    calls,
  };
}
test("one completed research run retains full reservation and partial synthesis warning", async (t) => {
  const id = randomUUID();
  let polls = 0;
  const f = await setup(t, (path) =>
    path.endsWith("run-research-async")
      ? Response.json({ research_run_id: id, error: null })
      : Response.json({
          research_run_id: id,
          status: ++polls === 1 ? "RUNNING" : "COMPLETED",
          deep_result: {
            result: "Interim report",
            citations: ["https://example.org/source"],
            termination_reason: "synthesis_failed",
          },
        }),
  );
  const result = await runDeepResearch({
    ...f,
    bounty: "source-hunter",
    query: "Trace the selected statistic.",
    pollMs: 1,
  });
  assert.equal(result.status, "COMPLETED");
  assert.ok(result.warnings.some((x) => x.includes("synthesis_failed")));
  assert.equal(
    f.calls.filter((x) => x.includes("run-research-async")).length,
    1,
  );
  const state = await f.controls.pool.status();
  assert.equal(state.reserved_microusd, 2000000);
  assert.equal(state.active_operations, 0);
  assert.equal(state.halted, false);
});
test("lost accepted run ID halts shared pool and never repeats POST", async (t) => {
  const f = await setup(t, () => Response.json({ unknown: "acceptance" }));
  await assert.rejects(
    runDeepResearch({ ...f, bounty: "source-hunter", query: "Trace source" }),
  );
  const state = await f.controls.pool.status();
  assert.equal(state.halted, true);
  assert.equal(state.active_operations, 1);
  assert.equal(state.reserved_microusd, 2000000);
  assert.equal(
    f.calls.filter((x) => x.includes("run-research-async")).length,
    1,
  );
});
test("explicit pre-run rejection retains reservation without claiming an uncertain live job", async (t) => {
  const f = await setup(
    t,
    () => new Response("withheld provider internals", { status: 403 }),
  );
  await assert.rejects(
    runDeepResearch({ ...f, bounty: "source-hunter", query: "Trace source" }),
  );
  const state = await f.controls.pool.status();
  assert.equal(state.halted, false);
  assert.equal(state.active_operations, 0);
  assert.equal(state.reserved_microusd, 2000000);
});
test("deadline cancels known run and verifies terminal state", async (t) => {
  const id = randomUUID();
  let cancelled = false;
  const f = await setup(t, (path) => {
    if (path.endsWith("run-research-async"))
      return Response.json({ research_run_id: id });
    if (path.endsWith("/cancel")) {
      cancelled = true;
      return Response.json({
        research_run_id: id,
        status: "CANCELLED",
        cancelled: true,
      });
    }
    return Response.json({
      research_run_id: id,
      status: cancelled ? "CANCELLED" : "RUNNING",
      deep_result: null,
    });
  });
  const result = await runDeepResearch({
    ...f,
    bounty: "compliance-map",
    query: "Compare public requirements",
    deadlineMs: 5,
    pollMs: 2,
  });
  assert.equal(result.status, "CANCELLED");
  assert.equal((await f.controls.pool.status()).halted, false);
  assert.equal(f.calls.filter((x) => x.endsWith("/cancel")).length, 1);
});
test("unconfirmed cancellation blocks subsequent work", async (t) => {
  const id = randomUUID();
  const f = await setup(t, (path) =>
    path.endsWith("run-research-async")
      ? Response.json({ research_run_id: id })
      : path.endsWith("/cancel")
        ? new Response("failed", { status: 503 })
        : Response.json({
            research_run_id: id,
            status: "RUNNING",
            deep_result: null,
          }),
  );
  await assert.rejects(
    runDeepResearch({
      ...f,
      bounty: "compliance-map",
      query: "Compare public requirements",
      deadlineMs: 3,
      pollMs: 1,
    }),
  );
  assert.equal((await f.controls.pool.status()).halted, true);
});
