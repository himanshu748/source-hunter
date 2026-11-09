import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ResearchReceipt } from "../../providers/research.js";
import { ProviderError } from "../../providers/pricing.js";
import { freshSourceQuery, corroborateFreshSource } from "../src/fresh.js";
import { RecordedBatch } from "../src/recorded.js";

const selection = {
    text: "Synthetic surveys counted 18 completed responses.",
    page_url: "https://arbitrary.example.org/research?edition=6",
    page_title: "An arbitrary sixth selection",
  },
  id = "sixth-dynamic-selection";
function proposal() {
  return {
    id,
    chain: {
      status: "candidate",
      summary: "An unverified producer candidate.",
      hops: [
        {
          url: selection.page_url,
          title: selection.page_title,
          role: "primary_candidate",
          quote: "Synthetic surveys counted 18 completed responses.",
          relationship_to_next: null as string | null,
        },
      ],
      limitations: [],
    },
    assessment: {
      label: "matches",
      reason: "Proposed wording match, not authorship proof.",
      selected_value: "18",
      source_value: "18",
      evidence: [
        {
          url: selection.page_url,
          quote: "Synthetic surveys counted 18 completed responses.",
          stance: "supports",
        },
      ],
    },
    dates: [
      {
        kind: "published",
        value: "2024-03-04",
        precision: "day",
        url: selection.page_url,
        quote: "4 March 2024",
      },
    ],
  };
}
function receipt(
  result: unknown = { results: [proposal()] },
  citations = [selection.page_url],
): ResearchReceipt {
  return {
    provider: "tinyfish-research",
    mode: "deep",
    research_run_id: randomUUID(),
    reservation_id: randomUUID(),
    reserved_microusd: 2000000,
    status: "COMPLETED",
    recorded_at: "2026-11-09T10:00:00.000Z",
    result: JSON.stringify(result),
    citations,
    termination_reason: "planner_done",
    warnings: [],
  };
}
function page(
  url: string,
  html = `<main><p>${selection.text}</p><time>4 March 2024</time></main>`,
) {
  return {
    html,
    source_url: url,
    final_url: url,
    observed_at: "2026-11-09T10:01:00.000Z",
    reservation_id: randomUUID(),
  };
}

test("fresh query uses the single rich contract for an arbitrary sixth selection", () => {
  const query = freshSourceQuery(selection, id);
  assert.ok(query.includes(JSON.stringify({ id, selection })));
  for (const field of [
    "results",
    "chain",
    "assessment",
    "dates",
    "historical_claim_date",
    "claim_reference_period",
  ])
    assert.ok(query.includes(field));
  assert.doesNotMatch(
    query,
    /FIVE|who-food|Cloudflare|Vatican|NASA|www\.who\.int/u,
  );
  assert.ok(query.length <= 10000);
  assert.throws(() => freshSourceQuery(selection, "unsafe.ref"));
});

test("fresh projection preserves identities, full assessment and dates in a schema-valid packet", async () => {
  const saved = receipt();
  let calls = 0;
  const packet = await corroborateFreshSource(
    saved,
    selection,
    async (url) => {
      calls++;
      return page(url);
    },
    { id },
  );
  assert.equal(calls, 1);
  assert.equal(packet.mode, "fresh_research");
  assert.equal(packet.research_jobs_started, 1);
  assert.equal(packet.source_page_checks, 1);
  assert.equal(packet.maximum_page_checks, 10);
  assert.ok(!("provider_requests_started" in packet));
  assert.equal(packet.provider_run_id, saved.research_run_id);
  assert.equal(packet.recorded_at, saved.recorded_at);
  assert.deepEqual(packet.trace.selection, selection);
  assert.deepEqual(packet.trace.chain.selection, selection);
  assert.equal(packet.trace.chain.provider_run_id, saved.research_run_id);
  assert.equal(packet.trace.id, id);
  assert.equal(packet.trace.assessment.label, "matches");
  assert.equal(packet.trace.assessment.scope, "selected_source_wording");
  assert.equal(packet.trace.assessment.target, "selected_quoted_text");
  assert.equal(packet.trace.dates[0]!.check, "exact_excerpt_matched");
  assert.equal(packet.trace.dates[0]!.value, "2024-03-04");
  assert.equal(packet.trace.earliest_source_status, "unresolved");
  assert.equal(packet.trace.primary_source_status, "not_established");
  assert.equal(packet.provenance.selected_context_status, "unassessed");
  assert.ok(
    RecordedBatch.safeParse({
      provider_run_id: packet.provider_run_id,
      recorded_at: packet.recorded_at,
      provider_jobs: 1,
      evidence_mode: packet.mode,
      traces: [packet.trace],
      excerpts: packet.excerpts,
    }).success,
  );
});

test("date evidence rejects embedded digits, partial ISO tokens and invalid proposed year or month values", async () => {
  const cases = [
    { value: "2023", precision: "year", quote: "Archive item 20230" },
    { value: "2023", precision: "year", quote: "Archive item 12023" },
    { value: "2023", precision: "year", quote: "Archive item x2023" },
    { value: "2023", precision: "year", quote: "Archive item 2023-13" },
    { value: "2023", precision: "year", quote: "Archive item 2023-03-04" },
    { value: "2023-03", precision: "month", quote: "Archive item 2023-030" },
    { value: "2023-03", precision: "month", quote: "Archive item 12023-03" },
    { value: "2023-03", precision: "month", quote: "Archive item 2023-03-04" },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Archive item 2024-03-040",
    },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Archive item 12024-03-04",
    },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Archive item 2024-03-04-01",
    },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Archive item 2024-03-04suffix",
    },
    { value: "2024-03-04", precision: "day", quote: "Published 4 March 20240" },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Published 104 March 2024",
    },
    { value: "2024-03-04", precision: "day", quote: "Published March 4 20240" },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Published March 104 2024",
    },
    { value: "20230", precision: "year", quote: "Archive item 20230" },
    { value: "2024-13", precision: "month", quote: "Archive item 2024-13" },
    { value: "2024-00", precision: "month", quote: "Archive item 2024-00" },
  ];
  for (const date of cases) {
    const value = proposal();
    value.dates = [{ kind: "published", url: selection.page_url, ...date }];
    const packet = await corroborateFreshSource(
      receipt({ results: [value] }),
      selection,
      async (url) =>
        page(
          url,
          `<main><p>${selection.text}</p><time>${date.quote}</time></main>`,
        ),
      { id },
    );
    assert.equal(
      packet.trace.dates[0]!.check,
      "research_only",
      JSON.stringify(date),
    );
  }
});

test("date evidence preserves complete ISO tokens and legitimate English publication dates", async () => {
  const cases = [
    { value: "2024", precision: "year", quote: "Published (2024)." },
    { value: "2024-03", precision: "month", quote: "Published (2024-03)." },
    { value: "2024-03-04", precision: "day", quote: "Published (2024-03-04)." },
    { value: "2024-03-04", precision: "day", quote: "Published 4 March 2024" },
    { value: "2024-03-04", precision: "day", quote: "Published March 4, 2024" },
    {
      value: "2024-03-04",
      precision: "day",
      quote: "Published 4th March 2024",
    },
    { value: "2024-03-04", precision: "day", quote: "Published 4 Mar 2024" },
  ];
  for (const date of cases) {
    const value = proposal();
    value.dates = [{ kind: "published", url: selection.page_url, ...date }];
    const packet = await corroborateFreshSource(
      receipt({ results: [value] }),
      selection,
      async (url) =>
        page(
          url,
          `<main><p>${selection.text}</p><time>${date.quote}</time></main>`,
        ),
      { id },
    );
    assert.equal(
      packet.trace.dates[0]!.check,
      "exact_excerpt_matched",
      JSON.stringify(date),
    );
  }
});

test("incomplete or malformed captured receipts cannot start source-page checks", async () => {
  const original = receipt();
  let calls = 0;
  for (const bad of [
    { ...original, status: "FAILED" },
    { ...original, status: "RUNNING" },
    { ...original, research_run_id: "not-a-run-id" },
    { ...original, recorded_at: "yesterday" },
    { ...original, reservation_id: "not-captured" },
    { ...original, result: null },
    {
      ...original,
      warnings: Array.from({ length: 11 }, () => "Unbounded warning"),
    },
  ]) {
    await assert.rejects(
      corroborateFreshSource(
        bad as ResearchReceipt,
        selection,
        async (url) => {
          calls++;
          return page(url);
        },
        { id },
      ),
      { code: "INVALID_RESEARCH_RECEIPT" },
    );
  }
  assert.equal(calls, 0);
});

test("stale ids, duplicate results, malformed reports and missing or uncited evidence stay unresolved", async () => {
  const stale = { ...proposal(), id: "older-selection" },
    uncited = proposal();
  uncited.assessment.evidence[0]!.url = "https://uncited.example.org/evidence";
  const noEvidence = proposal();
  noEvidence.assessment.evidence = [];
  for (const data of [
    { results: [stale] },
    { results: [proposal(), proposal()] },
    { results: [{ id }] },
    { unexpected: true },
    { results: [uncited] },
    { results: [noEvidence] },
  ]) {
    const packet = await corroborateFreshSource(
      receipt(data),
      selection,
      async (url) => page(url),
      { id },
    );
    assert.equal(packet.trace.assessment.label, "unresolved");
    assert.equal(packet.trace.earliest_source_status, "unresolved");
    assert.equal(packet.trace.primary_source_status, "not_established");
  }
  const wrongPage = proposal();
  wrongPage.chain.hops[0]!.url = "https://another.example.org/page";
  const packet = await corroborateFreshSource(
    receipt({ results: [wrongPage] }, [
      selection.page_url,
      wrongPage.chain.hops[0]!.url,
    ]),
    selection,
    async (url) => page(url),
    { id },
  );
  assert.equal(packet.trace.chain.status, "unresolved");
  assert.equal(packet.trace.chain.verification, "research_candidate");
});

test("fresh comparisons and date sources are dynamic cited side evidence, not invented attribution hops", async () => {
  const value = proposal(),
    comparison = "https://comparison.example.org/report",
    methodology = "https://method.example.org/vintage";
  value.assessment.label = "contradicted";
  value.assessment.evidence = [
    {
      url: comparison,
      quote: "The survey does not measure completions",
      stance: "refutes",
    },
  ];
  value.dates = [
    {
      kind: "claim_reference_period",
      value: "2022",
      precision: "year",
      url: methodology,
      quote: "Survey reference year 2022",
    },
  ];
  const seen: string[] = [];
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, [
      selection.page_url,
      comparison,
      methodology,
    ]),
    selection,
    async (url) => {
      seen.push(url);
      return page(
        url,
        url === comparison
          ? "<p>The survey does not measure completions</p>"
          : url === methodology
            ? "<p>Survey reference year 2022</p>"
            : undefined,
      );
    },
    { id },
  );
  assert.deepEqual(seen, [selection.page_url, comparison, methodology]);
  assert.equal(packet.trace.chain.hops.length, 1);
  assert.equal(packet.trace.assessment.evidence[0]!.quote_check, "matched");
  assert.equal(packet.trace.dates[0]!.check, "exact_excerpt_matched");
  assert.equal(packet.trace.assessment.proposed_label, "contradicted");
  assert.equal(packet.trace.assessment.label, "unresolved");
});

test("exact unique URLs are checked once and at most ten checks are dispatched", async () => {
  const value = proposal();
  const urls = Array.from(
    { length: 8 },
    (_, i) => `https://reports.example.org/source-${i}?version=one`,
  );
  value.chain.hops = [
    value.chain.hops[0]!,
    ...urls.slice(0, 7).map((url, i) => ({
      url,
      title: `Source ${i}`,
      role: i === 6 ? "primary_candidate" : "intermediary",
      quote: "Synthetic upstream measurement",
      relationship_to_next: null,
    })),
  ];
  value.chain.hops[0]!.role = "selected_page";
  value.assessment.evidence = urls.map((url) => ({
    url,
    quote: "Synthetic upstream measurement",
    stance: "clarifies",
  }));
  value.dates = Array.from({ length: 5 }, (_, i) => ({
    kind: "published",
    value: "2024",
    precision: "year",
    url: `https://dates.example.org/${i}`,
    quote: "Published 2024",
  }));
  const citations = [
      selection.page_url,
      ...urls,
      ...value.dates.map((d) => d.url),
    ],
    seen: string[] = [];
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, citations),
    selection,
    async (url) => {
      seen.push(url);
      return page(
        url,
        `<main><p>${selection.text}</p><p>Synthetic upstream measurement</p><p>Published 2024</p></main>`,
      );
    },
    { id },
  );
  assert.equal(seen.length, 10);
  assert.equal(new Set(seen).size, 10);
  assert.equal(packet.source_page_checks, 10);
  assert.ok(
    packet.page_failures.some((row) => row.code === "PAGE_CHECK_LIMIT"),
  );
  for (const seenUrl of seen) assert.ok(citations.includes(seenUrl));
  assert.ok(seen.includes(urls[0]!));
  assert.ok(!seen.includes(urls[0]!.replace("?version=one", "")));
  for (const maximumUrls of [-1, 11, 1.1])
    await assert.rejects(
      corroborateFreshSource(receipt(), selection, async (url) => page(url), {
        id,
        maximumUrls,
      }),
      { code: "INVALID_FETCH_BOUND" },
    );
});

test("source failure is recorded once without retry and failed documents cannot assert missing links", async () => {
  const value = proposal(),
    upstream = "https://upstream.example.org/report";
  value.chain.hops[0]!.role = "selected_page";
  value.chain.hops.push({
    ...value.chain.hops[0]!,
    url: upstream,
    role: "primary_candidate",
  });
  const seen: string[] = [];
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, [selection.page_url, upstream]),
    selection,
    async (url) => {
      seen.push(url);
      if (url === selection.page_url) throw new Error("SOURCE_FAILURE");
      return page(url);
    },
    { id },
  );
  assert.deepEqual(seen, [selection.page_url, upstream]);
  assert.equal(packet.trace.selection_quote_check, "fetch_failed");
  assert.equal(packet.trace.chain.hops[0]!.link_to_next, "fetch_failed");
  assert.equal(packet.trace.assessment.label, "unresolved");
  assert.deepEqual(packet.page_failures, [
    { url: selection.page_url, code: "SOURCE_FAILURE" },
  ]);
});

test("application errors, challenges, empty pages and unrendered shells preserve unknown quotation and edge checks", async () => {
  const value = proposal(),
    upstream = "https://upstream.example.org/report";
  value.chain.hops[0]!.role = "selected_page";
  value.chain.hops.push({
    ...value.chain.hops[0]!,
    url: upstream,
    role: "primary_candidate",
  });
  for (const html of [
    "<title>Application error</title><h1>Application error</h1><p>A client-side exception has occurred.</p>",
    "<title>Just a moment...</title><p>Enable JavaScript and cookies to continue</p>",
    "",
    "<div id='root'></div><script>loadApp()</script>",
    "<p>Loading...</p>",
  ]) {
    const packet = await corroborateFreshSource(
      receipt({ results: [value] }, [selection.page_url, upstream]),
      selection,
      async (url) => page(url, url === selection.page_url ? html : undefined),
      { id },
    );
    assert.equal(packet.trace.selection_quote_check, "fetch_failed");
    assert.equal(packet.trace.chain.hops[0]!.quote_check, "fetch_failed");
    assert.equal(packet.trace.chain.hops[0]!.link_to_next, "fetch_failed");
    assert.equal(packet.page_receipts[0]!.document_status, "unusable");
    assert.match(packet.page_receipts[0]!.html_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(packet.trace.assessment.label, "unresolved");
  }
});

test("only a usable checked document can establish that a quotation or outgoing link was not found", async () => {
  const value = proposal(),
    upstream = "https://upstream.example.org/report";
  value.chain.hops[0]!.role = "selected_page";
  value.chain.hops.push({
    ...value.chain.hops[0]!,
    url: upstream,
    role: "primary_candidate",
  });
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, [selection.page_url, upstream]),
    selection,
    async (url) =>
      page(
        url,
        "<article><p>A complete synthetic source has unrelated but usable content.</p></article>",
      ),
    { id },
  );
  assert.equal(packet.trace.selection_quote_check, "not_found");
  assert.equal(packet.trace.chain.hops[0]!.quote_check, "not_found");
  assert.equal(packet.trace.chain.hops[0]!.link_to_next, "not_found");
});

test("a clipped or exhausted excerpt cannot prove the full quote or promote chain corroboration", async () => {
  const long = {
    ...selection,
    text: "This deliberately long synthetic selection contains exactly twenty four separate words to leave only one word for exported evidence on this same source page",
  };
  const value = proposal();
  value.chain.hops[0]!.quote = "This deliberately long synthetic selection";
  value.assessment.evidence[0]!.quote = value.chain.hops[0]!.quote;
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }),
    long,
    async (url) => page(url, `<p>${long.text}</p>`),
    { id },
  );
  assert.equal(packet.trace.chain.hops[0]!.quote_check, "not_checked");
  assert.equal(packet.trace.chain.hops[0]!.excerpt_shortened, true);
  assert.equal(packet.trace.chain.verification, "research_candidate");
  assert.equal(packet.trace.assessment.label, "unresolved");
});

test("short form-only selectors cannot establish quotation or link absence while short static prose remains usable", async () => {
  const value = proposal(),
    upstream = "https://upstream.example.org/annual";
  value.chain.hops[0]!.role = "selected_page";
  value.chain.hops.push({
    ...value.chain.hops[0]!,
    url: upstream,
    role: "primary_candidate",
  });
  for (const intro of [
    "<p hidden>Use the form below to select a report.</p>",
    "<p>Use this form to select an annual report.</p>",
  ]) {
    const shell = `<header>Public reports</header><nav><a href='/reports'>Browse</a></nav><main><h1>Reports</h1>${intro}<form><label>Report<select><option>Annual</option></select></label><label>Year<select></select></label><input type='submit'></form><div></div></main><footer>Contact</footer>`;
    const packet = await corroborateFreshSource(
      receipt({ results: [value] }, [selection.page_url, upstream]),
      selection,
      async (url) => page(url, url === selection.page_url ? shell : undefined),
      { id },
    );
    assert.equal(packet.page_receipts[0]!.document_status, "unusable");
    assert.equal(
      packet.page_receipts[0]!.failure_code,
      "SOURCE_FORM_ONLY_DOCUMENT",
    );
    assert.equal(packet.trace.selection_quote_check, "fetch_failed");
    assert.equal(packet.trace.chain.hops[0]!.quote_check, "fetch_failed");
    assert.equal(packet.trace.chain.hops[0]!.link_to_next, "fetch_failed");
    assert.match(
      packet.trace.chain.hops[0]!.relationship_to_next!,
      /uncheckable/u,
    );
  }
  const staticPage = `<main><p>A brief synthetic annual analysis contains meaningful findings.</p><form><select><option>Annual</option></select></form></main>`;
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, [selection.page_url, upstream]),
    selection,
    async (url) => page(url, staticPage),
    { id },
  );
  assert.equal(packet.page_receipts[0]!.document_status, "usable");
  assert.equal(packet.trace.selection_quote_check, "not_found");
  assert.equal(packet.trace.chain.hops[0]!.link_to_next, "not_found");
  assert.match(
    packet.trace.chain.hops[0]!.relationship_to_next!,
    /captured document/u,
  );
});

test("a complete shorter support quote has its own checked reference without adding words from a clipped or longer hop", async () => {
  const selected = {
    ...selection,
    text: Array.from({ length: 17 }, (_, i) => `Selected${i}`).join(" "),
  };
  const support =
    "Independent observers counted seven complete survey responses";
  for (const hopQuote of [
    `${support} today for this report`,
    `${support} today`,
  ]) {
    const value = proposal();
    value.chain.hops[0]!.quote = hopQuote;
    value.assessment.evidence[0]!.quote = support;
    const packet = await corroborateFreshSource(
      receipt({ results: [value] }),
      selected,
      async (url) =>
        page(url, `<main><p>${selected.text}</p><p>${hopQuote}</p></main>`),
      { id },
    );
    const evidence = packet.trace.assessment.evidence[0]!;
    assert.equal(evidence.quote_check, "matched");
    assert.notEqual(evidence.quote_ref, `${id}.chain.hops.0.quote`);
    assert.equal(
      packet.excerpts.find((e) => e.ref === evidence.quote_ref)?.quote,
      support,
    );
    assert.equal(packet.trace.assessment.label, "matches");
    assert.equal(packet.trace.chain.hops[0]!.quote, `${support} today`);
    // The independent seven-word reference is wholly contained in the retained
    // eight-word hop: only those eight words consume the remaining source budget.
    assert.equal(
      selected.text.split(/\s/u).length +
        packet.trace.chain.hops[0]!.quote.split(/\s/u).length,
      25,
    );
    assert.equal(
      packet.excerpts.filter((e) => e.url === selected.page_url).length,
      1,
    );
  }
});

test("a retained prefix cannot stand in for the full support quotation when no words remain", async () => {
  const selected = {
    ...selection,
    text: Array.from({ length: 21 }, (_, i) => `Selected${i}`).join(" "),
  };
  const support =
    "Independent observers counted seven complete survey responses";
  const value = proposal();
  value.chain.hops[0]!.quote = `${support} today for this report`;
  value.assessment.evidence[0]!.quote = support;
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }),
    selected,
    async (url) =>
      page(url, `<main><p>${selected.text}</p><p>${support}</p></main>`),
    { id },
  );
  assert.equal(packet.trace.chain.hops[0]!.quote.split(/\s/u).length, 4);
  assert.equal(packet.trace.assessment.evidence[0]!.quote_check, "not_checked");
  assert.equal(packet.trace.assessment.evidence[0]!.quote_ref, null);
  assert.equal(packet.trace.assessment.label, "unresolved");
});

test("relationship descriptions separate observed exact links from proposed attribution roles", async () => {
  const value = proposal(),
    upstream = "https://upstream.example.org/report";
  value.chain.hops[0]!.role = "selected_page";
  value.chain.hops.push({
    ...value.chain.hops[0]!,
    url: upstream,
    role: "primary_candidate",
  });
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, [selection.page_url, upstream]),
    selection,
    async (url) =>
      page(
        url,
        `<main><p>${selection.text}</p><a href='${upstream}'>Source</a></main>`,
      ),
    { id },
  );
  const first = packet.trace.chain.hops[0]!;
  assert.equal(first.link_to_next, "matched");
  assert.match(first.relationship_to_next!, /exact outgoing link.*observed/u);
  assert.match(
    first.relationship_to_next!,
    /attribution role remains a Research proposal/u,
  );
  assert.doesNotMatch(first.relationship_to_next!, /unchecked/u);
  assert.equal(packet.trace.chain.hops[1]!.relationship_to_next, null);
});

test("terminal control failures and cancellation stop all subsequent reader dispatch", async () => {
  const value = proposal(),
    extra = "https://other.example.org/evidence";
  value.assessment.evidence.push({
    url: extra,
    quote: "Independent synthetic explanation",
    stance: "clarifies",
  });
  for (const code of [
    "AUTHENTICATION",
    "AUTHORIZATION_REQUIRED",
    "PROVIDER_QUOTA",
    "PRICING_CHANGED",
    "PRICING_UNAVAILABLE",
    "HALTED",
    "STATE_FAILURE",
    "PROVIDER_UNCERTAIN",
    "PROVIDER_FAILURE",
    "PROVIDER_TIMEOUT",
    "RESPONSE_TOO_LARGE",
    "CANCELLED",
  ]) {
    let calls = 0;
    await assert.rejects(
      corroborateFreshSource(
        receipt({ results: [value] }, [selection.page_url, extra]),
        selection,
        async () => {
          calls++;
          throw new ProviderError(
            code,
            "Private transport details must not escape.",
          );
        },
        { id },
      ),
      { code },
    );
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    corroborateFreshSource(
      receipt({ results: [value] }, [selection.page_url, extra]),
      selection,
      async (url) => {
        calls++;
        controller.abort();
        return page(url);
      },
      { id, signal: controller.signal },
    ),
    { code: "CANCELLED" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    corroborateFreshSource(
      receipt(),
      selection,
      async () => {
        calls++;
        throw new Error();
      },
      { id, signal: controller.signal },
    ),
    { code: "CANCELLED" },
  );
  assert.equal(calls, 1);
});

test("unsafe and overlong proposed sources never reach the reader or invalidate safe packet references", async () => {
  const longUrl = "https://long.example.org/" + "a".repeat(2100);
  assert.throws(
    () => freshSourceQuery({ ...selection, page_url: longUrl }, id),
    { code: "INVALID_INPUT" },
  );
  const value = proposal();
  value.assessment.evidence = [
    {
      url: "https://127.0.0.1/private?token=secret",
      quote: "Unsafe",
      stance: "supports",
    },
    { url: longUrl, quote: "Uncheckable source", stance: "clarifies" },
  ];
  value.dates.push({ ...value.dates[0]!, url: "https://localhost/private" });
  const seen: string[] = [];
  const packet = await corroborateFreshSource(
    receipt({ results: [value] }, [selection.page_url, longUrl]),
    selection,
    async (url) => {
      seen.push(url);
      return page(url);
    },
    { id },
  );
  assert.deepEqual(seen, [selection.page_url]);
  assert.ok(!JSON.stringify(packet).includes("token=secret"));
  assert.ok(
    packet.trace.assessment.evidence.every(
      (row) => typeof row.source_url === "string",
    ),
  );
  assert.ok(
    packet.trace.dates.every((row) => typeof row.source_url === "string"),
  );
});

test("same numbers or arbitrary negation do not prove a proposed drift verdict", async () => {
  for (const label of ["rounded", "changed", "misquoted", "contradicted"]) {
    const value = proposal();
    value.assessment.label = label;
    value.assessment.source_value = "19";
    value.assessment.evidence[0]!.quote =
      "Not 19 requests from a different survey";
    value.dates.push({ ...value.dates[0]!, kind: "updated" });
    const packet = await corroborateFreshSource(
      receipt({ results: [value] }),
      selection,
      async (url) =>
        page(
          url,
          `<main><p>${selection.text}</p><p>Not 19 requests from a different survey</p><time>4 March 2024</time></main>`,
        ),
      { id },
    );
    assert.equal(packet.trace.assessment.label, "unresolved");
    assert.equal(packet.trace.assessment.proposed_label, label);
  }
});

test("a zero page bound preserves uncaptured evidence as not checked", async () => {
  let calls = 0;
  const packet = await corroborateFreshSource(
    receipt(),
    selection,
    async (url) => {
      calls++;
      return page(url);
    },
    { id, maximumUrls: 0 },
  );
  assert.equal(calls, 0);
  assert.equal(packet.trace.selection_quote_check, "not_checked");
  assert.equal(packet.trace.chain.hops[0]!.quote_check, "not_checked");
  assert.equal(packet.trace.assessment.label, "unresolved");
  assert.equal(packet.source_page_checks, 0);
});
