import test from "node:test";
import assert from "node:assert/strict";
import { sourceQuery, sourceResult } from "../src/core.js";
import { publicUrl } from "../../providers/public-url.js";
import type { ResearchReceipt } from "../../providers/research.js";
const input = {
  text: "Synthetic selected statistic: 40 percent.",
  page_url: "https://example.org/article",
  page_title: "Synthetic offline article",
};
const chain = {
  status: "candidate",
  summary: "Synthetic offline chain.",
  hops: [
    {
      url: input.page_url,
      title: "Article",
      role: "selected_page",
      quote: input.text,
      relationship_to_next: "Attributes the figure to the primary report.",
    },
    {
      url: "https://primary.example.org/report",
      title: "Primary",
      role: "primary_candidate",
      quote: "Synthetic report: 40 percent.",
      relationship_to_next: null,
    },
  ],
  limitations: [],
};
const receipt: ResearchReceipt = {
  provider: "tinyfish-research",
  mode: "deep",
  research_run_id: "00000000-0000-4000-8000-000000000000",
  reservation_id: "synthetic",
  reserved_microusd: 2000000,
  status: "COMPLETED",
  recorded_at: new Date().toISOString(),
  result: JSON.stringify(chain),
  citations: chain.hops.map((h) => h.url),
  termination_reason: "planner_done",
  warnings: [],
};
test("cited ordered chain remains a research candidate until corroborated", () => {
  const r = sourceResult(input, receipt);
  assert.equal(r.status, "candidate");
  assert.equal(r.verification, "research_candidate");
  assert.ok(r.limitations.some((x) => x.includes("corroboration")));
});
test("provider string limitations are preserved without another paid run and display excerpts stay short", () => {
  const r = sourceResult(input, {
    ...receipt,
    result: JSON.stringify({
      ...chain,
      limitations: "Primary repository access was not achieved.",
      hops: chain.hops.map((h) => ({
        ...h,
        quote: "one two three four five six seven eight nine ten eleven twelve",
      })),
    }),
  });
  assert.equal(r.status, "candidate");
  assert.ok(
    r.limitations.includes("Primary repository access was not achieved."),
  );
  assert.ok(
    r.hops.every(
      (h) => h.quote.split(/\s+/).length <= 10 && h.excerpt_shortened,
    ),
  );
});
test("a selection already on the primary source needs one cited hop, never an invented intermediary", () => {
  const single = {
    ...chain,
    hops: [
      {
        ...chain.hops[0]!,
        role: "primary_candidate",
        relationship_to_next: null,
      },
    ],
  };
  assert.equal(
    sourceResult(input, { ...receipt, result: JSON.stringify(single) }).status,
    "candidate",
  );
  assert.equal(
    sourceResult(input, {
      ...receipt,
      result: JSON.stringify({
        ...single,
        hops: [{ ...single.hops[0], role: "selected_page" }],
      }),
    }).status,
    "unresolved",
  );
});
test("uncited, circular, wrong-page and malformed chains stay unresolved", () => {
  assert.equal(
    sourceResult(input, { ...receipt, citations: [input.page_url] }).status,
    "unresolved",
  );
  assert.equal(
    sourceResult(
      { ...input, page_url: "https://other.example.org/article" },
      receipt,
    ).status,
    "unresolved",
  );
  assert.equal(
    sourceResult(input, {
      ...receipt,
      result: JSON.stringify({
        ...chain,
        hops: [chain.hops[0], chain.hops[0]],
      }),
    }).status,
    "unresolved",
  );
  assert.equal(
    sourceResult(input, {
      ...receipt,
      result: "The origin is probably a report.",
    }).status,
    "unresolved",
  );
});
test("public evidence URL boundary rejects local and credential-bearing inputs", () => {
  for (const url of [
    "http://example.org/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://secret@site.example/",
    "https://site.example/?token=secret",
  ])
    assert.throws(() => publicUrl(url));
  assert.equal(
    publicUrl("https://example.org/a#section"),
    "https://example.org/a",
  );
});
test("query serializes untrusted content and bounds the highlighted text", () => {
  assert.ok(sourceQuery(input).includes("untrusted data"));
  assert.throws(() => sourceQuery({ ...input, text: "x".repeat(1001) }));
});
