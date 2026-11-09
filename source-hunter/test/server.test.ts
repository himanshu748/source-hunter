import test from "node:test";
import assert from "node:assert/strict";
import { localServer } from "./local-server.js";
test("local HTTP entry point rejects hostile origins and shows live-disabled failure without a key", async (t) => {
  const url = await localServer(t);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + "/compliance-map")).status, 404);
  const health = await (await fetch(url + "/health")).json();
  assert.equal(health.mode, "recorded_only");
  assert.equal(health.extension_configured, false);
  assert.equal(health.recorded_trace_count, 5);
  assert.equal(health.provider_health_checked, false);
  assert.equal(
    (await fetch(url + "/assets/manrope.woff2")).headers.get("content-type"),
    "font/woff2",
  );
  assert.equal(
    (await fetch(url + "/downloads/source-hunter-extension.zip")).status,
    200,
  );
  const body = JSON.stringify({
    text: "Synthetic selection in offline HTTP test.",
    page_url: "https://example.org/",
    page_title: "Synthetic",
  });
  for (const origin of [
    "https://evil.example",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    const response = await fetch(url + "/api/source-hunter", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 403);
  }
  const response = await fetch(url + "/api/source-hunter", {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body,
  });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.code, "LIVE_DISABLED");
  const traversal = await fetch(url + "/%2e%2e/shared/config.ts");
  assert.equal(traversal.status, 404);
});
