import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  chmod,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvestigation,
  consumeResume,
  recordResumeAvailability,
  fetchPricingTier,
  writeInvestigationFile,
  type RecoveryPoolStatus,
} from "../src/recovery.js";
import { localServer } from "./local-server.js";

const selection = {
  text: "Synthetic surveys counted 18 completed responses.",
  page_url: "https://example.org/report?edition=one",
  page_title: "Saved synthetic title",
};
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "source-recovery-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const id = randomUUID(),
    status: RecoveryPoolStatus = {
      pool_id: "synthetic-pool",
      grant_id: randomUUID(),
      halted: false,
      active_operations: 0,
      by_policy: { "fetch-public": { operations: 2 } },
    };
  const { directory } = await createInvestigation(base, id, selection, status);
  const receipt = {
    provider: "tinyfish-research",
    mode: "deep",
    research_run_id: randomUUID(),
    reservation_id: randomUUID(),
    reserved_microusd: 2000000,
    status: "COMPLETED",
    recorded_at: "2026-11-09T10:00:00.000Z",
    result: JSON.stringify({ results: [] }),
    citations: [selection.page_url],
    termination_reason: "planner_done",
    warnings: [],
  };
  await writeInvestigationFile(directory, "accepted.json", {
    research_run_id: receipt.research_run_id,
    reservation: { id: receipt.reservation_id },
  });
  await writeInvestigationFile(directory, "research-receipt.json", receipt);
  return { base, id, status, directory, receipt };
}

test("recovery reuses the captured completed receipt with exact selection and consumes one manual continuation", async (t) => {
  const f = await fixture(t);
  const input = JSON.parse(
    await readFile(join(f.directory, "input.json"), "utf8"),
  );
  assert.equal(input.fetch_operations_before, 2);
  assert.equal(
    await recordResumeAvailability(
      f.base,
      f.id,
      f.status,
      "PRICING_UNAVAILABLE",
    ),
    true,
  );
  const resumed = await consumeResume(
    f.base,
    f.id,
    {
      ...selection,
      text: "  Synthetic surveys counted 18   completed responses.  ",
      page_title: "Changed title is not identity",
    },
    f.status,
  );
  assert.deepEqual(resumed.receipt, f.receipt);
  assert.deepEqual(resumed.input.selection, selection);
  assert.equal(resumed.receipt.research_run_id, f.receipt.research_run_id);
  assert.equal(
    JSON.parse(
      await readFile(join(f.directory, "resume-consumed.json"), "utf8"),
    ).provider_run_id,
    f.receipt.research_run_id,
  );
  await assert.rejects(consumeResume(f.base, f.id, selection, f.status), {
    code: "RESUME_UNAVAILABLE",
  });
  assert.equal(
    await recordResumeAvailability(
      f.base,
      f.id,
      f.status,
      "PRICING_UNAVAILABLE",
    ),
    false,
  );
});

test("a Fetch reservation, active operation, halted pool or changed grant forbids recovery", async (t) => {
  const f = await fixture(t);
  for (const changed of [
    { ...f.status, by_policy: { "fetch-public": { operations: 3 } } },
    { ...f.status, halted: true },
    { ...f.status, active_operations: 1 },
    { ...f.status, grant_id: randomUUID() },
    { ...f.status, pool_id: "different-pool" },
  ])
    assert.equal(
      await recordResumeAvailability(
        f.base,
        f.id,
        changed,
        "PRICING_UNAVAILABLE",
      ),
      false,
    );
  assert.equal(
    await recordResumeAvailability(f.base, f.id, f.status, "SOURCE_FAILURE"),
    false,
  );
  assert.equal(
    await recordResumeAvailability(
      f.base,
      f.id,
      f.status,
      "PRICING_UNAVAILABLE",
    ),
    true,
  );
  for (const changed of [
    { ...f.status, by_policy: { "fetch-public": { operations: 3 } } },
    { ...f.status, halted: true },
    { ...f.status, active_operations: 1 },
    { ...f.status, grant_id: randomUUID() },
  ])
    await assert.rejects(consumeResume(f.base, f.id, selection, changed), {
      code: "RESUME_UNAVAILABLE",
    });
});

test("resume requires exact public URL and normalized text without creating a marker on mismatch", async (t) => {
  const f = await fixture(t);
  await recordResumeAvailability(f.base, f.id, f.status, "PRICING_UNAVAILABLE");
  for (const changed of [
    {
      ...selection,
      text: "A different synthetic claim has eighteen responses.",
    },
    { ...selection, page_url: selection.page_url + "&version=2" },
    { ...selection, page_url: "https://example.org/report" },
  ])
    await assert.rejects(consumeResume(f.base, f.id, changed, f.status), {
      code: "RESUME_UNAVAILABLE",
    });
  await assert.rejects(readFile(join(f.directory, "resume-consumed.json")), {
    code: "ENOENT",
  });
  await assert.rejects(
    consumeResume(f.base, "../not-a-uuid", selection, f.status),
    { code: "RESUME_UNAVAILABLE" },
  );
});

test("missing metadata, mutated input/accepted/receipt and mismatched accepted identity fail closed", async (t) => {
  for (const name of ["input.json", "accepted.json", "research-receipt.json"]) {
    const f = await fixture(t);
    await recordResumeAvailability(
      f.base,
      f.id,
      f.status,
      "PRICING_UNAVAILABLE",
    );
    const path = join(f.directory, name),
      bytes = await readFile(path, "utf8");
    await writeFile(path, bytes + " ", { mode: 0o600 });
    await assert.rejects(consumeResume(f.base, f.id, selection, f.status), {
      code: "RESUME_UNAVAILABLE",
    });
  }
  const missing = await fixture(t);
  await assert.rejects(
    consumeResume(missing.base, missing.id, selection, missing.status),
    { code: "RESUME_UNAVAILABLE" },
  );
  await writeFile(
    join(missing.directory, "accepted.json"),
    JSON.stringify({
      research_run_id: randomUUID(),
      reservation: { id: missing.receipt.reservation_id },
    }),
    { mode: 0o600 },
  );
  assert.equal(
    await recordResumeAvailability(
      missing.base,
      missing.id,
      missing.status,
      "PRICING_UNAVAILABLE",
    ),
    false,
  );
});

test("unsafe shared files, symlinks, oversized files and non-completed research cannot be resumed", async (t) => {
  for (const type of ["permissions", "symlink", "oversized", "failed"]) {
    const f = await fixture(t);
    await recordResumeAvailability(
      f.base,
      f.id,
      f.status,
      "PRICING_UNAVAILABLE",
    );
    const path = join(f.directory, "research-receipt.json");
    if (type === "permissions") await chmod(path, 0o644);
    if (type === "symlink") {
      await rm(path);
      await symlink(join(f.directory, "accepted.json"), path);
    }
    if (type === "oversized")
      await writeFile(path, " ".repeat(8000001), { mode: 0o600 });
    if (type === "failed")
      await writeFile(
        path,
        JSON.stringify({ ...f.receipt, status: "FAILED" }),
        { mode: 0o600 },
      );
    await assert.rejects(consumeResume(f.base, f.id, selection, f.status), {
      code: "RESUME_UNAVAILABLE",
    });
  }
  const directory = await fixture(t);
  await chmod(directory.directory, 0o755);
  assert.equal(
    await recordResumeAvailability(
      directory.base,
      directory.id,
      directory.status,
      "PRICING_UNAVAILABLE",
    ),
    false,
  );
});

test("concurrent continuation requests can consume the exclusive marker only once", async (t) => {
  const f = await fixture(t);
  await recordResumeAvailability(f.base, f.id, f.status, "PRICING_UNAVAILABLE");
  const outcomes = await Promise.allSettled([
    consumeResume(f.base, f.id, selection, f.status),
    consumeResume(f.base, f.id, selection, f.status),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
  );
});

test("Fetch pricing tier is explicit and invalid configuration is rejected", () => {
  assert.equal(fetchPricingTier({}), undefined);
  assert.equal(
    fetchPricingTier({ TINYFISH_FETCH_PRICING_TIER: "hobby" }),
    "hobby",
  );
  assert.equal(
    fetchPricingTier({ TINYFISH_FETCH_PRICING_TIER: "builder" }),
    "builder",
  );
  for (const value of ["", "auto", "Hobby", " hobby", "free"])
    assert.throws(
      () => fetchPricingTier({ TINYFISH_FETCH_PRICING_TIER: value }),
      { code: "INVALID_INPUT" },
    );
});

test("resume HTTP route preserves origin protection, rejects traversal and respects disabled providers", async (t) => {
  const url = await localServer(t),
    body = JSON.stringify({ selection, investigation_id: randomUUID() });
  assert.equal(
    (
      await fetch(url + "/api/source-hunter/resume", {
        method: "POST",
        headers: {
          Origin: "https://hostile.example",
          "Content-Type": "application/json",
        },
        body,
      })
    ).status,
    403,
  );
  const malformed = await fetch(url + "/api/source-hunter/resume", {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ selection, investigation_id: "../../private" }),
  });
  assert.equal(malformed.status, 400);
  const disabled = await fetch(url + "/api/source-hunter/resume", {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body,
  });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).code, "LIVE_DISABLED");
});
