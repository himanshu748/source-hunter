import test from "node:test";
import assert from "node:assert/strict";
import { PrivateApiKey, type EndpointPolicy } from "../../shared/index.js";
import { observePrice, providerJson, usdToMicro } from "../pricing.js";

const key = new PrivateApiKey("synthetic-only-provider-test-value");
const policy: EndpointPolicy = {
  id: "research-deep",
  unit: "run",
  max_units_per_operation: 1,
  max_unit_price_microusd: 2000000,
  max_operations: 3,
  max_active_operations: 2,
  enforcement: {
    mechanism: "fixed_request_contract",
    source_url: "https://docs.tinyfish.ai/research-api/reference",
    description: "One flat-price Deep run, no follow-up or automatic retry.",
  },
};
const wallet = (
  meters: unknown[] = [
    {
      label: "TinyFish Research (Deep)",
      unit_amount: "2",
      currency: "USD",
      per: "run",
    },
  ],
  balance = "10",
) => ({ available_balance: balance, currency: "USD", rates: { meters } });
const reply =
  (value: unknown): typeof fetch =>
  async () =>
    Response.json(value);
const code = (value: string) => (error: unknown) =>
  (error as { code: string }).code === value;

test("USD decimal conversion never rounds cost down", () => {
  assert.equal(usdToMicro("0.016"), 16000);
  assert.equal(usdToMicro("0.10000000"), 100000);
  for (const value of [
    "0.0000001",
    "1e-3",
    "-1",
    "Infinity",
    "9007199254740992",
  ])
    assert.throws(() => usdToMicro(value), code("PRICING_UNAVAILABLE"));
});
test("fresh price observation requires the exact wallet meter and sufficient existing funds", async () => {
  const quote = await observePrice({
    key,
    policy,
    meter: { label: "TinyFish Research (Deep)", per: "run" },
    request: reply(wallet()),
  });
  assert.equal(quote.unit_price_microusd, 2000000);
  assert.ok(
    Date.parse(quote.expires_at) - Date.parse(quote.checked_at) <= 30000,
  );
  assert.ok(!JSON.stringify(quote).includes("balance"));
  for (const balance of ["0", "1.99", "-1"])
    await assert.rejects(
      observePrice({
        key,
        policy,
        meter: { label: "TinyFish Research (Deep)", per: "run" },
        request: reply(wallet(undefined, balance)),
      }),
      code("PROVIDER_QUOTA"),
    );
});
test("missing, duplicate, mismatched and increased pricing fail closed", async () => {
  const meter = {
    label: "TinyFish Research (Deep)",
    unit_amount: "2",
    currency: "USD",
    per: "run",
  };
  for (const meters of [
    [],
    [meter, meter],
    [{ ...meter, unit_amount: "2.01" }],
    [{ ...meter, per: "minute" }],
    [{ ...meter, currency: "EUR" }],
  ]) {
    await assert.rejects(
      observePrice({
        key,
        policy,
        meter: { label: meter.label, per: "run" },
        request: reply(wallet(meters)),
      }),
    );
  }
});
test("provider request blocks credential-bearing and external origins before sending the key", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const url of [
    "https://evil.example/v1/wallet",
    "https://agent.tinyfish.ai.evil.example/",
    "https://user:secret@agent.tinyfish.ai/v1/wallet",
    "https://agent.tinyfish.ai:8000/v1/wallet",
  ]) {
    await assert.rejects(
      providerJson({ key, url, request }),
      code("INVALID_INPUT"),
    );
  }
  assert.equal(calls, 0);
});
test("HTTP and transport errors withhold raw bodies and do not retry", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return new Response("secret raw trace", { status: 403 });
  };
  await assert.rejects(
    providerJson({ key, url: "https://agent.tinyfish.ai/v1/wallet", request }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes("secret"));
      return code("AUTHENTICATION")(e);
    },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    providerJson({
      key,
      url: "https://agent.tinyfish.ai/v1/wallet",
      request: async () => {
        throw new Error("synthetic-only-provider-test-value");
      },
    }),
    code("PROVIDER_FAILURE"),
  );
});
test("pre-dispatch cancellation and byte limits are enforced", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return Response.json({ long: "x".repeat(100) });
  };
  await assert.rejects(
    providerJson({
      key,
      url: "https://agent.tinyfish.ai/v1/wallet",
      signal: AbortSignal.abort(),
      request,
    }),
    code("CANCELLED"),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    providerJson({
      key,
      url: "https://agent.tinyfish.ai/v1/wallet",
      maxBytes: 20,
      request,
    }),
    code("RESPONSE_TOO_LARGE"),
  );
  assert.equal(calls, 1);
});
test("decoded Unicode credential echoes are withheld and bounds must be finite integers", async () => {
  const secret = "synthetic-only-provider-test-value";
  const escaped = [...secret]
    .map((char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  await assert.rejects(
    providerJson({
      key,
      url: "https://agent.tinyfish.ai/v1/wallet",
      request: async () =>
        new Response('{"nested":[{"echo":"' + escaped + '"}]}', {
          headers: { "Content-Type": "application/json" },
        }),
    }),
    code("PROVIDER_FAILURE"),
  );
  for (const timeoutMs of [NaN, Infinity, 1.5])
    await assert.rejects(
      providerJson({
        key,
        url: "https://agent.tinyfish.ai/v1/wallet",
        timeoutMs,
        request: reply({}),
      }),
      code("INVALID_INPUT"),
    );
});
