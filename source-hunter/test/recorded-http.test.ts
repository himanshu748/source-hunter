import test from "node:test";
import assert from "node:assert/strict";
import { localServer } from "./local-server.js";

test("configured extension can preflight and retrieve only the matching saved investigation without usable live controls", async (t) => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const origin = `chrome-extension://${extensionId}`;
  const url = await localServer(t, { extensionId, liveEnabled: true });
  const health = await fetch(url + "/health", { headers: { Origin: origin } });
  assert.equal(health.headers.get("access-control-allow-origin"), origin);
  const state = await health.json();
  assert.equal(state.extension_configured, true);
  assert.equal(state.provider_health_checked, false);
  const batch = await (await fetch(url + "/recorded-traces.json")).json();
  const path = url + "/api/source-hunter/recorded-match";
  const preflight = await fetch(path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(
    preflight.headers.get("access-control-allow-methods") ?? "",
    /POST/,
  );
  const selection = batch.traces[0].selection;
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(selection),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "recorded_research");
  assert.equal(body.provider_requests_started, 0);
  assert.equal(body.trace.selection.text, selection.text);
  assert.equal(body.trace.id, batch.traces[0].id);
  assert.equal(body.provider_run_id, batch.provider_run_id);
  assert.equal(body.recorded_at, batch.recorded_at);
  assert.ok(body.trace.assessment && body.trace.dates);
  const unmatched = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...selection,
      text: "A different public claim with no saved investigation.",
    }),
  });
  assert.equal(unmatched.status, 404);
  assert.equal((await unmatched.json()).code, "NO_RECORDED_MATCH");
  for (const wrongOrigin of [
    "https://evil.example",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: { ...headers, Origin: wrongOrigin },
          body: JSON.stringify(selection),
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...selection,
          page_url: "https://user:password@example.org/",
        }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...selection, text: "x".repeat(12000) }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(url + "/api/compliance-map", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    404,
  );
});
