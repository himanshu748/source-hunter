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
import { fetchHtml, fetchMeter, type FetchPricingTier } from "../fetch.js";
import { ProviderError } from "../pricing.js";

type Meter = {
  label: string;
  unit_amount: string;
  currency: string;
  per: string;
};
const hobby = (price = "0"): Meter => ({
  label: "TinyFish Fetch (Hobby)",
  unit_amount: price,
  currency: "USD",
  per: "url",
});
const builder = (price = "0.001"): Meter => ({
  label: "TinyFish Fetch (Builder)",
  unit_amount: price,
  currency: "USD",
  per: "url",
});
const generic = (): Meter => ({
  label: "TinyFish Fetch",
  unit_amount: "0",
  currency: "USD",
  per: "url",
});
const code = (expected: string) => (error: unknown) =>
  error instanceof ProviderError && error.code === expected;

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fetch-pricing-offline-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const material =
    "synthetic-offline-fetch-pricing-key-not-a-provider-credential";
  const now = Date.now();
  const grant: AuthorizationGrant = {
    version: 1,
    provider: "tinyfish",
    pool_id: "offline-fetch-pricing",
    grant_id: randomUUID(),
    authorized_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60000).toISOString(),
    currency: "USD",
    max_reserved_microusd: 1000000,
    max_concurrent_operations: 1,
    state_directory: join(root, "pool"),
    key_sha256: createHash("sha256").update(material).digest("hex"),
    allowed_bounties: ["source-hunter"],
    policies: [
      {
        id: "fetch-public",
        unit: "url",
        max_units_per_operation: 1,
        max_unit_price_microusd: 0,
        max_operations: 5,
        max_active_operations: 1,
        enforcement: {
          mechanism: "fixed_request_contract",
          source_url: "https://docs.tinyfish.ai/fetch-api/reference",
          description:
            "One URL, zero-price-only policy in an isolated offline transport test.",
        },
      },
    ],
  };
  const pool = new PoolLedger(grant);
  await pool.initialize();
  const url = "https://example.org/synthetic-offline-pricing-fixture";
  const args = {
    pool,
    key: new PrivateApiKey(material),
    bountyId: "source-hunter",
    policyId: "fetch-public",
    url,
    selectors: ["main"],
    assertAllowed: (candidate: string) => assert.equal(candidate, url),
  };
  return { args, pool };
}
function transport(
  meters: Meter[],
  content = "<main>Synthetic offline response only.</main>",
) {
  const seen = { wallets: 0, sourceRequests: 0 };
  const bodies: (Record<string, unknown> & { urls: string[] })[] = [];
  const request: typeof fetch = async (input, init) => {
    if (String(input) === "https://agent.tinyfish.ai/v1/wallet") {
      seen.wallets++;
      return new Response(
        JSON.stringify({
          available_balance: "0",
          currency: "USD",
          rates: { meters },
        }),
      );
    }
    assert.equal(String(input), "https://api.fetch.tinyfish.ai/");
    seen.sourceRequests++;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      urls: string[];
    };
    bodies.push(body);
    assert.equal(body.urls.length, 1);
    return new Response(
      JSON.stringify({
        results: [
          {
            url: body.urls[0],
            final_url: body.urls[0],
            format: "html",
            text: content,
          },
        ],
        errors: [],
      }),
    );
  };
  return { request, seen, bodies };
}

test("Fetch meter binding preserves the generic default and maps only explicit lowercase tiers", () => {
  assert.deepEqual(fetchMeter(), { label: "TinyFish Fetch", per: "url" });
  assert.deepEqual(fetchMeter("hobby"), {
    label: "TinyFish Fetch (Hobby)",
    per: "url",
  });
  assert.deepEqual(fetchMeter("builder"), {
    label: "TinyFish Fetch (Builder)",
    per: "url",
  });
  for (const value of ["Hobby", "HOBBY", "", "cheapest", null, {}, 0])
    assert.throws(
      () => fetchMeter(value as FetchPricingTier),
      code("INVALID_INPUT"),
    );
});

test("explicit Hobby uses its exact zero-price meter among both tiers and freshly preflights every request", async (t) => {
  const f = await fixture(t),
    mock = transport([builder(), hobby()]);
  for (let i = 0; i < 2; i++) {
    const result = await fetchHtml({
      ...f.args,
      pricingTier: "hobby",
      request: mock.request,
    });
    assert.equal(result.source_url, f.args.url);
  }
  assert.deepEqual(mock.seen, { wallets: 2, sourceRequests: 2 });
  const state = await f.pool.status();
  assert.equal(state.operations_used, 2);
  assert.equal(state.reserved_microusd, 0);
  assert.equal(state.active_operations, 0);
  assert.equal(state.halted, false);
});

test("explicit Builder cannot fall back to free Hobby under a zero-price grant", async (t) => {
  const f = await fixture(t),
    mock = transport([builder(), hobby()]);
  await assert.rejects(
    fetchHtml({ ...f.args, pricingTier: "builder", request: mock.request }),
    code("PRICING_CHANGED"),
  );
  assert.deepEqual(mock.seen, { wallets: 1, sourceRequests: 0 });
  assert.equal((await f.pool.status()).operations_used, 0);
});

test("missing, duplicate, positive or malformed Hobby quotes stop before reservation and source dispatch", async (t) => {
  const f = await fixture(t);
  const cases: { meters: Meter[]; error: string }[] = [
    { meters: [builder(), generic()], error: "PRICING_UNAVAILABLE" },
    { meters: [builder(), hobby(), hobby()], error: "PRICING_UNAVAILABLE" },
    {
      meters: [hobby("0.000001"), builder("0"), generic()],
      error: "PRICING_CHANGED",
    },
    {
      meters: [{ ...hobby(), per: "query" }, builder()],
      error: "PRICING_UNAVAILABLE",
    },
    {
      meters: [{ ...hobby(), currency: "EUR" }, builder()],
      error: "PRICING_UNAVAILABLE",
    },
    {
      meters: [{ ...hobby(), label: "TinyFish Fetch (Hobby) " }, builder()],
      error: "PRICING_UNAVAILABLE",
    },
  ];
  for (const sample of cases) {
    const mock = transport(sample.meters);
    await assert.rejects(
      fetchHtml({ ...f.args, pricingTier: "hobby", request: mock.request }),
      code(sample.error),
    );
    assert.deepEqual(mock.seen, { wallets: 1, sourceRequests: 0 });
  }
  assert.equal((await f.pool.status()).operations_used, 0);
});

test("generic callers retain their old contract and never silently select a tier", async (t) => {
  const f = await fixture(t),
    missing = transport([builder(), hobby()]);
  await assert.rejects(
    fetchHtml({ ...f.args, request: missing.request }),
    code("PRICING_UNAVAILABLE"),
  );
  assert.deepEqual(missing.seen, { wallets: 1, sourceRequests: 0 });
  const present = transport([generic(), builder(), hobby()]);
  await fetchHtml({ ...f.args, request: present.request });
  assert.deepEqual(present.seen, { wallets: 1, sourceRequests: 1 });
  assert.equal((await f.pool.status()).operations_used, 1);
});

test("invalid runtime tier fails before any provider request or reservation", async (t) => {
  const f = await fixture(t),
    mock = transport([builder(), hobby()]);
  await assert.rejects(
    fetchHtml({
      ...f.args,
      pricingTier: "cheapest" as FetchPricingTier,
      request: mock.request,
    }),
    code("INVALID_INPUT"),
  );
  assert.deepEqual(mock.seen, { wallets: 0, sourceRequests: 0 });
  assert.equal((await f.pool.status()).operations_used, 0);
});

test("omitted and explicit undefined selectors omit the field while retaining every fixed request bound", async (t) => {
  const f = await fixture(t),
    mock = transport([builder(), hobby()]);
  const { selectors: _selectors, ...withoutSelectors } = f.args;
  await fetchHtml({
    ...withoutSelectors,
    pricingTier: "hobby",
    request: mock.request,
  });
  await fetchHtml({
    ...f.args,
    selectors: undefined,
    pricingTier: "hobby",
    request: mock.request,
  });
  for (const body of mock.bodies) {
    assert.equal(Object.hasOwn(body, "include_selectors"), false);
    assert.deepEqual(body.urls, [f.args.url]);
    assert.equal(body.format, "html");
    assert.equal(body.ttl, 0);
    assert.equal(body.links, false);
    assert.equal(body.image_links, false);
    assert.equal(body.per_url_timeout_ms, 45000);
  }
  assert.deepEqual(mock.seen, { wallets: 2, sourceRequests: 2 });
});

test("supplied selector arrays still require one to twenty bounded nonempty strings before any provider request", async (t) => {
  const f = await fixture(t),
    mock = transport([builder(), hobby()]);
  for (const selectors of [
    [],
    Array.from({ length: 21 }, () => "main"),
    [""],
    ["x".repeat(1001)],
    [null],
    null,
    "body",
  ]) {
    await assert.rejects(
      fetchHtml({
        ...f.args,
        selectors: selectors as readonly string[],
        pricingTier: "hobby",
        request: mock.request,
      }),
      code("INVALID_INPUT"),
    );
  }
  assert.deepEqual(mock.seen, { wallets: 0, sourceRequests: 0 });
  assert.equal((await f.pool.status()).operations_used, 0);
});

test("a reviewed PDF-shaped URL accepts the bounded extracted-text contract from an offline provider without selectors", async (t) => {
  const f = await fixture(t),
    url = "https://example.org/synthetic-offline-document.pdf";
  const content =
    "Synthetic PDF extraction fixture. No document was fetched over the network.";
  const mock = transport([builder(), hobby()], content);
  const result = await fetchHtml({
    ...f.args,
    url,
    selectors: undefined,
    pricingTier: "hobby",
    request: mock.request,
    assertAllowed: (candidate) => assert.equal(candidate, url),
  });
  assert.equal(result.html, content);
  assert.equal(result.source_url, url);
  assert.equal(result.final_url, url);
  assert.equal(Object.hasOwn(mock.bodies[0]!, "include_selectors"), false);
  assert.equal(mock.bodies[0]!.format, "html");
  const state = await f.pool.status();
  assert.equal(state.operations_used, 1);
  assert.equal(state.active_operations, 0);
  assert.equal(state.reserved_microusd, 0);
  assert.equal(state.halted, false);
});
