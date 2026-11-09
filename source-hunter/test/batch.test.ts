import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ResearchReceipt } from "../../providers/research.js";
import {
  SOURCE_BATCH_SELECTIONS,
  sourceBatchQuery,
  projectSourceBatch,
  corroborateSourceBatch,
  type BatchSelection,
} from "../src/batch.js";

const input: BatchSelection = {
  id: "synthetic-statistic",
  selection: {
    text: "Synthetic figure 40 percent was observed.",
    page_url: "https://example.org/entry",
    page_title: "Explicit synthetic test page",
  },
  context: "Synthetic offline fixture only.",
  historical_quotation: false,
};
function item() {
  return {
    id: input.id,
    chain: {
      status: "candidate",
      summary: "Synthetic",
      hops: [
        {
          url: input.selection.page_url,
          title: "Synthetic source",
          role: "primary_candidate",
          quote: "Synthetic figure 40 percent",
          relationship_to_next: null as string | null,
        },
      ],
      limitations: [],
    },
    assessment: {
      label: "matches",
      reason: "Synthetic evidence.",
      selected_value: null as string | null,
      source_value: null as string | null,
      evidence: [
        {
          url: input.selection.page_url,
          quote: "Synthetic figure 40 percent",
          stance: "supports",
        },
      ],
    },
    dates: [
      {
        kind: "published",
        value: "2024-01-02",
        precision: "day",
        url: input.selection.page_url,
        quote: "2 January 2024",
      },
    ],
  };
}
function receipt(
  results: unknown[],
  citations = [input.selection.page_url],
): ResearchReceipt {
  return {
    provider: "tinyfish-research",
    mode: "deep",
    research_run_id: randomUUID(),
    reservation_id: randomUUID(),
    reserved_microusd: 2000000,
    status: "COMPLETED",
    recorded_at: "2026-11-08T08:00:00.000Z",
    result: JSON.stringify({ results }),
    citations,
    termination_reason: "planner_done",
    warnings: [],
  };
}
function page(
  url: string,
  html = `<main><p>${input.selection.text}</p><time>2 January 2024</time></main>`,
) {
  return {
    html,
    source_url: url,
    final_url: url,
    observed_at: "2026-11-08T08:01:00.000Z",
    reservation_id: randomUUID(),
  };
}
test("one bounded batch contains five real selections and preserves historical examination context", () => {
  const query = sourceBatchQuery();
  assert.equal(SOURCE_BATCH_SELECTIONS.length, 5);
  assert.ok(query.length <= 10000);
  for (const selected of SOURCE_BATCH_SELECTIONS)
    assert.ok(query.includes(selected.id));
  assert.match(query, /not automatically the earliest source/);
  assert.match(query, /never falsely accuse the Vatican article/);
  assert.throws(() => sourceBatchQuery([input]));
});
test("missing, duplicate and malformed results stay unresolved without guessed chains", () => {
  for (const results of [[], [item(), item()], [{ id: input.id }]]) {
    const projected = projectSourceBatch(receipt(results), [input]);
    assert.equal(projected.traces.length, 1);
    assert.equal(projected.traces[0]!.chain.status, "unresolved");
    assert.equal(projected.traces[0]!.proposal, null);
  }
});
test("one exact page corroborates a chain, matching claim and English publication date without duplicate reads", async () => {
  let calls = 0;
  const result = await corroborateSourceBatch(
    projectSourceBatch(receipt([item()]), [input]),
    async (url) => {
      calls++;
      return page(url);
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.provider_jobs, 1);
  assert.equal(
    result.traces[0]!.chain.verification,
    "quotes_and_links_corroborated",
  );
  assert.equal(result.traces[0]!.assessment.label, "matches");
  assert.equal(result.traces[0]!.dates[0]!.check, "exact_excerpt_matched");
  assert.equal(result.traces[0]!.earliest_source_status, "candidate_only");
});
test("uncited and cross-case evidence cannot borrow another source's authority", async () => {
  const value = item();
  value.assessment.evidence = [
    {
      url: "https://other.example.org/refute",
      quote: "Synthetic figure 40 percent",
      stance: "supports",
    },
  ];
  let otherCalls = 0;
  const result = await corroborateSourceBatch(
    projectSourceBatch(
      receipt(
        [value],
        [input.selection.page_url, value.assessment.evidence[0]!.url],
      ),
      [input],
    ),
    async (url) => {
      if (url.includes("other")) otherCalls++;
      return page(url);
    },
  );
  assert.equal(otherCalls, 0);
  assert.equal(result.traces[0]!.assessment.label, "unresolved");
  assert.equal(
    result.traces[0]!.assessment.evidence[0]!.quote_check,
    "uncited",
  );
});
test("a failed exact URL is never retried, and the finite page allowance leaves explicit gaps", async () => {
  const second = {
    ...input,
    id: "other",
    selection: {
      ...input.selection,
      page_url: "https://second.example.org/entry",
    },
  };
  let calls = 0;
  const result = await corroborateSourceBatch(
    projectSourceBatch(receipt([item()]), [input, second]),
    async () => {
      calls++;
      throw new Error("SOURCE_FAILURE");
    },
    { maximumUrls: 1 },
  );
  assert.equal(calls, 1);
  assert.equal(result.page_checks, 1);
  assert.equal(result.traces[0]!.assessment.label, "unresolved");
  assert.ok(result.page_failures.some((f) => f.code === "PAGE_CHECK_LIMIT"));
});
test("historical refutation remains proposed without a checked contextual basis and labels its quoted target", async () => {
  const selected = {
      ...input,
      historical_quotation: true,
      comparison_urls: ["https://science.example.org/moon"],
    },
    value = item();
  value.assessment = {
    label: "contradicted",
    reason: "Synthetic historical claim examined against a separate source.",
    selected_value: null,
    source_value: null,
    evidence: [
      {
        url: selected.comparison_urls[0]!,
        quote: "It is not visible from the Moon",
        stance: "refutes",
      },
    ],
  };
  const result = await corroborateSourceBatch(
    projectSourceBatch(
      receipt([value], [input.selection.page_url, ...selected.comparison_urls]),
      [selected],
    ),
    async (url) =>
      page(
        url,
        url === selected.comparison_urls[0]
          ? "<p>It is not visible from the Moon</p>"
          : `<p>${input.selection.text}</p>`,
      ),
  );
  assert.equal(result.traces[0]!.assessment.label, "unresolved");
  assert.equal(result.traces[0]!.assessment.proposed_label, "contradicted");
  assert.equal(result.traces[0]!.assessment.target, "historical_quoted_claim");
  assert.match(
    result.traces[0]!.assessment.reason,
    /not a finding against its current author/u,
  );
  assert.equal(result.traces[0]!.earliest_source_status, "unresolved");
});
test("empty excerpts, impossible dates and unsupported numeric differences cannot become proof", async () => {
  const value = item();
  value.assessment.label = "misquoted";
  value.assessment.selected_value = "40";
  value.assessment.source_value = "12";
  value.dates[0]!.value = "2024-02-30";
  const result = await corroborateSourceBatch(
    projectSourceBatch(receipt([value]), [input]),
    async (url) => page(url),
  );
  assert.equal(result.traces[0]!.assessment.label, "unresolved");
  assert.equal(result.traces[0]!.dates[0]!.check, "research_only");
  const empty = item();
  empty.assessment.evidence[0]!.quote = "   ";
  const noEvidence = await corroborateSourceBatch(
    projectSourceBatch(receipt([empty]), [input]),
    async (url) => page(url),
  );
  assert.equal(noEvidence.traces[0]!.assessment.label, "unresolved");
});
test("all public excerpts stay short and within the per-page verbatim budget", async () => {
  const result = await corroborateSourceBatch(
    projectSourceBatch(receipt([item()]), [input]),
    async (url) => page(url),
  );
  const trace = result.traces[0]!,
    all = [
      trace.selection.text,
      ...trace.chain.hops.map((h) => h.quote),
      ...result.excerpts
        .filter((e) => e.url === trace.selection.page_url)
        .map((e) => e.quote),
    ];
  assert.ok(
    all.reduce(
      (sum, text) => sum + text.split(/\s+/u).filter(Boolean).length,
      0,
    ) <= 25,
  );
  assert.ok(trace.chain.hops.every((h) => h.quote.split(/\s+/u).length <= 8));
});
test("a checked selected-source match never promotes a failed upstream provenance chain", async () => {
  const value = item(),
    upstream = "https://primary.example.org/report";
  value.chain = {
    status: "candidate",
    summary: "Synthetic proposal",
    hops: [
      {
        url: input.selection.page_url,
        title: "Selected",
        role: "selected_page",
        quote: "Synthetic figure 40 percent",
        relationship_to_next: "Proposed attribution",
      },
      {
        url: upstream,
        title: "Upstream",
        role: "primary_candidate",
        quote: "Synthetic figure 40 percent",
        relationship_to_next: null,
      },
    ],
    limitations: [],
  };
  value.assessment.evidence.push({
    url: upstream,
    quote: "Synthetic figure 40 percent",
    stance: "supports",
  });
  const result = await corroborateSourceBatch(
    projectSourceBatch(receipt([value], [input.selection.page_url, upstream]), [
      input,
    ]),
    async (url) => {
      if (url === upstream) throw new Error("SOURCE_FAILURE");
      return page(url);
    },
  );
  assert.equal(result.traces[0]!.assessment.label, "matches");
  assert.equal(result.traces[0]!.assessment.scope, "selected_source_wording");
  assert.equal(result.traces[0]!.chain.verification, "research_candidate");
  assert.equal(result.traces[0]!.earliest_source_status, "unresolved");
  assert.match(
    result.traces[0]!.assessment.reason,
    /does not establish every proposed attribution hop/u,
  );
});
test("bounded ancillary fields remain usable and a clipped date excerpt never proves a whole date", async () => {
  const long = {
    ...input,
    selection: {
      ...input.selection,
      text: "Synthetic figure 40 percent was observed with these explicitly synthetic extra words making this twenty one words long for this fixture",
    },
  };
  const value = item();
  value.assessment.source_value = "A bounded explanatory value ".repeat(12);
  value.assessment.evidence = Array.from({ length: 6 }, () => ({
    ...value.assessment.evidence[0]!,
  }));
  value.chain = {
    status: "candidate",
    summary: "Synthetic",
    hops: [
      {
        url: input.selection.page_url,
        title: "Source",
        role: "primary_candidate",
        quote: "Synthetic figure 40",
        relationship_to_next: null,
      },
    ],
    limitations: [],
  };
  value.assessment.evidence.forEach((row) => {
    row.quote = "Synthetic figure 40";
  });
  const projected = projectSourceBatch(receipt([value]), [long]);
  assert.ok(projected.traces[0]!.proposal);
  const result = await corroborateSourceBatch(projected, async (url) =>
    page(url, `<p>${long.selection.text}</p><time>2 January 2024</time>`),
  );
  assert.equal(result.traces[0]!.dates[0]!.check, "research_only");
  assert.ok(result.excerpts.some((excerpt) => excerpt.quote === "2"));
});
