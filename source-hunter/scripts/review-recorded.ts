/**
 * Reproduce the locally reviewed projection of this one recorded five-selection batch.
 *
 * Run from bounty-drop-002:
 *   npx tsx source-hunter/scripts/review-recorded.ts
 *   npx tsx source-hunter/scripts/review-recorded.ts --check
 * Optional positional arguments: original-batch.json source-review.json output.json.
 *
 * Inputs are public artifacts only. This script makes no network/provider requests,
 * reads no credentials/captures, and does not evaluate provenance or truth generally.
 * The explicit decisions in source-review.json are the human-reviewed inputs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { publicUrl } from "../../providers/public-url.js";
import { RecordedBatch } from "../src/recorded.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Url = z.string().max(4000).transform(publicUrl);
const CheckedAt = z.union([z.iso.datetime(), z.iso.date()]);
const Note = z.string().max(8000);
const Check = z.string().min(1).max(100);
const LocalReview = RecordedBatch.shape.local_review.unwrap();
const Source = z
  .object({
    url: Url,
    title: z.string().min(1).max(300),
    kind: Check,
    page_status: Check,
    checked_at: CheckedAt.nullable(),
    check_method: z.string().max(150),
    excerpts: z.record(
      z.string().min(1).max(100),
      z.object({ quote: z.string().min(1).max(1500), check: Check }).strict(),
    ),
    notes: z.array(Note).max(30),
    html_sha256: Hash.optional(),
    fetch_reservation_id: z.uuid().optional(),
    publication_date: z.string().max(100).optional(),
    original_provider_failure: Check.optional(),
    ordinary_html_sha256: Hash.optional(),
    document_sha256: Hash.optional(),
  })
  .strict();
const ExcerptReference = z.object({
  source_id: z.string().min(1).max(100),
  excerpt_key: z.string().min(1).max(100).nullable(),
});
const Decision = z
  .object({
    id: z.string().min(1).max(100),
    selection_sha256: Hash,
    selection_quote_check: Check,
    selection_url_aliases: z.array(Url).max(5).optional(),
    selection_alias_reason: Note.optional(),
    context: z.string().max(4000),
    chain: z.object({
      status: z.enum(["candidate", "unresolved"]),
      summary: z.string().max(4000),
      hops: z.array(
        ExcerptReference.extend({
          role: z.enum(["selected_page", "intermediary", "primary_candidate"]),
          unchecked_check: Check,
        }).strict(),
      ),
      edges: z.array(
        z
          .object({
            from_source_id: z.string(),
            to_source_id: z.string(),
            kind: z.literal("attribution"),
            check: z.literal("matched"),
            note: z.string().max(1000),
          })
          .strict(),
      ),
      limitations: z.array(Note).max(40),
    }),
    assessment: z.object({
      label: z.enum([
        "matches",
        "rounded",
        "changed",
        "misquoted",
        "contradicted",
        "unresolved",
      ]),
      target: z.string().max(100),
      reason: z.string().max(4000),
      scope: z.string().max(200),
      check: Check,
      evidence: z.array(
        ExcerptReference.extend({
          stance: z.enum(["supports", "refutes", "clarifies"]),
          unchecked_check: Check,
        }).strict(),
      ),
    }),
    dates: z.array(
      ExcerptReference.extend({
        kind: Check,
        value: z.string().max(100).nullable(),
        precision: z.string().max(30),
        check: Check,
      }).strict(),
    ),
    earliest_source_status: z.literal("unresolved"),
    primary_source_status: z.enum([
      "primary_publication_identified",
      "producer_report_reached",
      "authoritative_statement_only",
      "authoritative_explanation_only",
      "not_established",
    ]),
    review_summary: z.string().max(4000),
  })
  .strict();
const SourceReview = z
  .object({
    version: z.literal(1),
    review_id: z.literal("source-hunter-recorded-source-review-2026-11-09"),
    local_review: LocalReview,
    original_batch: z.object({
      provider_run_id: z.uuid(),
      provider_jobs: z.literal(1),
      recorded_at: z.iso.datetime(),
      sha256: Hash,
    }),
    sources: z.record(z.string(), Source),
    observed_links: z.array(
      z
        .object({
          from_source_id: z.string(),
          to_url: Url,
          relationship: z.enum([
            "attribution",
            "report_download",
            "resource_index",
            "methodology",
            "source_note",
            "guidelines",
          ]),
          check: z.literal("matched_href"),
          check_method: z.string().max(150),
          checked_at: CheckedAt.nullable(),
          note: Note,
        })
        .strict(),
    ),
    decisions: z.array(Decision).length(5),
    explicit_url_aliases: z.array(
      z
        .object({
          canonical_url: Url,
          alias_url: Url,
          checked_at: CheckedAt,
          method: z.string().max(150),
          reason: Note,
        })
        .strict(),
    ),
  })
  .strict();

// Fixed reviewed paths; a comparison, refutation or unobserved redirect cannot
// accidentally become another consecutive hop during artifact regeneration.
const reviewedPaths = {
  "who-food-2023": ["who_food", "who_sofi_landing", "sofi_doi"],
  "cloudflare-ddos-q1-2024": ["cf_blog"],
  "who-air-99": ["who_air", "who_air_db"],
  "nasa-earth-year": ["nasa_facts"],
  "great-wall-historical": ["vatican_wall"],
} as const;
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function artifactPath(path: string) {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(path);
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const args = process.argv.slice(2).filter((arg) => arg !== "--check");
  assert.ok(args.length <= 3, "Expected at most three artifact paths.");
  const directory = new URL("../evidence/", import.meta.url);
  const originalPath =
    args[0] ?? fileURLToPath(new URL("live-batch.json", directory));
  const reviewPath =
    args[1] ?? fileURLToPath(new URL("source-review.json", directory));
  const outputPath =
    args[2] ?? fileURLToPath(new URL("reviewed-batch.json", directory));
  const actualOutput = await artifactPath(outputPath);
  assert.notEqual(
    actualOutput,
    await artifactPath(originalPath),
    "Never overwrite the original batch.",
  );
  assert.notEqual(
    actualOutput,
    await artifactPath(reviewPath),
    "Never overwrite the source review.",
  );

  const originalBytes = await readFile(originalPath);
  const originalRaw: unknown = JSON.parse(originalBytes.toString("utf8"));
  const original = RecordedBatch.parse(originalRaw);
  const review = SourceReview.parse(
    JSON.parse(await readFile(reviewPath, "utf8")),
  );
  const originalHash = sha256(originalBytes);
  assert.equal(originalHash, review.original_batch.sha256);
  assert.equal(originalHash, review.local_review.original_batch_sha256);
  assert.equal(original.provider_run_id, review.original_batch.provider_run_id);
  assert.equal(original.provider_jobs, review.original_batch.provider_jobs);
  assert.equal(original.recorded_at, review.original_batch.recorded_at);
  assert.deepEqual(
    original.traces.map((trace) => trace.id),
    Object.keys(reviewedPaths),
    "This review is specific to the recorded five-selection batch.",
  );
  assert.deepEqual(
    review.decisions.map((decision) => decision.id),
    original.traces.map((trace) => trace.id),
  );

  const sources = review.sources;
  const source = (id: string) => {
    const value = sources[id];
    assert.ok(value, `Unknown reviewed source: ${id}`);
    return value;
  };
  const receipts = z
    .object({
      page_receipts: z.array(
        z.object({
          url: Url,
          checked_at: z.iso.datetime(),
          html_sha256: Hash,
          fetch_reservation_id: z.uuid(),
        }),
      ),
    })
    .parse(originalRaw).page_receipts;
  for (const item of Object.values(sources)) {
    if (!item.fetch_reservation_id) continue;
    const receipt = receipts.find((entry) => entry.url === item.url);
    assert.ok(
      receipt,
      "A retained TinyFish receipt must exist in the original.",
    );
    assert.equal(item.fetch_reservation_id, receipt.fetch_reservation_id);
    assert.equal(item.checked_at, receipt.checked_at);
    assert.equal(item.html_sha256, receipt.html_sha256);
  }

  // Only the two specifically observed WHO air URLs are aliases. There is no
  // trailing-slash, query-string or domain-wide equivalence rule.
  const airUrl = original.traces[2]!.selection.page_url;
  const allowedAlias = airUrl.slice(0, -1);
  assert.deepEqual(
    review.explicit_url_aliases.map(({ canonical_url, alias_url }) => [
      canonical_url,
      alias_url,
    ]),
    [[airUrl, allowedAlias]],
  );
  const canonicalForBudget = (url: string) =>
    review.explicit_url_aliases.find((alias) => alias.alias_url === url)
      ?.canonical_url ?? url;
  const exportedQuotes = new Map<string, Set<string>>();
  const countQuote = (url: string, quote: string) => {
    if (!quote.trim()) return;
    const key = canonicalForBudget(url);
    const quotes = exportedQuotes.get(key) ?? new Set<string>();
    quotes.add(quote.normalize("NFKC").replace(/\s+/gu, " ").trim());
    exportedQuotes.set(key, quotes);
  };
  for (const item of Object.values(sources))
    for (const excerpt of Object.values(item.excerpts))
      countQuote(item.url, excerpt.quote);

  const excerpts: z.infer<typeof RecordedBatch>["excerpts"] = [];
  const addExcerpt = (
    traceId: string,
    sourceId: string,
    excerptKey: string | null,
  ) => {
    if (excerptKey === null) return null;
    const item = source(sourceId);
    const excerpt = item.excerpts[excerptKey];
    assert.ok(excerpt, `Missing excerpt: ${sourceId}.${excerptKey}`);
    const ref = `${traceId}.review.${sourceId}.${excerptKey}`;
    if (!excerpts.some((entry) => entry.ref === ref))
      excerpts.push({ ref, url: item.url, quote: excerpt.quote });
    countQuote(item.url, excerpt.quote);
    return ref;
  };
  const traces = review.decisions.map((decision, index) => {
    const prior = original.traces[index]!;
    assert.equal(
      decision.selection_sha256,
      sha256(JSON.stringify(prior.selection)),
    );
    const path = decision.chain.hops.map((hop) => hop.source_id);
    assert.deepEqual(
      path,
      reviewedPaths[decision.id as keyof typeof reviewedPaths],
    );
    assert.equal(decision.chain.edges.length, path.length - 1);
    assert.equal(source(path[0]!).url, prior.selection.page_url);
    const aliases = decision.selection_url_aliases ?? [];
    assert.deepEqual(
      aliases,
      decision.id === "who-air-99" ? [allowedAlias] : [],
    );
    if (aliases.length) assert.ok(decision.selection_alias_reason);
    const hops = decision.chain.hops.map((hop, hopIndex) => {
      const item = source(hop.source_id);
      const excerpt = hop.excerpt_key
        ? item.excerpts[hop.excerpt_key]
        : undefined;
      if (hop.excerpt_key) assert.ok(excerpt);
      const edge = decision.chain.edges[hopIndex];
      if (edge) {
        assert.equal(edge.from_source_id, hop.source_id);
        assert.equal(edge.to_source_id, path[hopIndex + 1]);
        assert.ok(
          review.observed_links.some(
            (link) =>
              link.from_source_id === hop.source_id &&
              link.to_url === source(edge.to_source_id).url &&
              ["attribution", "source_note"].includes(link.relationship),
          ),
          "A consecutive attribution edge needs an explicitly reviewed href.",
        );
      }
      const quote = excerpt?.quote ?? "";
      countQuote(item.url, quote);
      return {
        url: item.url,
        title: item.title,
        role: hop.role,
        quote,
        quote_check: excerpt?.check ?? hop.unchecked_check,
        relationship_to_next: edge?.note ?? null,
        link_to_next: edge?.check ?? "not_applicable",
        checked_at: item.checked_at,
        html_sha256: item.html_sha256 ?? null,
        fetch_reservation_id: item.fetch_reservation_id ?? null,
        check_method: item.check_method,
        publication_date: item.publication_date ?? null,
        excerpt_shortened: false,
      };
    });
    countQuote(prior.selection.page_url, prior.selection.text);
    const reviewedTrace = {
      id: prior.id,
      selection: structuredClone(prior.selection),
      ...(aliases.length ? { selection_url_aliases: aliases } : {}),
      context: decision.context,
      selection_quote_check: decision.selection_quote_check,
      chain: {
        selection: structuredClone(prior.chain.selection),
        provider_run_id: prior.chain.provider_run_id,
        recorded_at: prior.chain.recorded_at,
        verification: "research_candidate",
        status: decision.chain.status,
        summary: decision.chain.summary,
        hops,
        limitations: decision.chain.limitations,
      },
      assessment: {
        ...decision.assessment,
        evidence: decision.assessment.evidence.map((item) => ({
          source_url: source(item.source_id).url,
          stance: item.stance,
          quote_ref: addExcerpt(prior.id, item.source_id, item.excerpt_key),
          quote_check: item.excerpt_key
            ? source(item.source_id).excerpts[item.excerpt_key]!.check
            : item.unchecked_check,
        })),
      },
      dates: decision.dates.map((item) => ({
        kind: item.kind,
        value: item.value,
        precision: item.precision,
        source_url: source(item.source_id).url,
        quote_ref: addExcerpt(prior.id, item.source_id, item.excerpt_key),
        check: item.check,
      })),
      earliest_source_status: decision.earliest_source_status,
      primary_source_status: decision.primary_source_status,
      local_review: {
        ...review.local_review,
        summary: decision.review_summary,
        limitations: decision.chain.limitations,
      },
    };
    return reviewedTrace;
  });
  const budget = [...exportedQuotes].map(([url, quotes]) => ({
    url,
    words: [...quotes].reduce(
      (sum, quote) => sum + quote.split(/\s+/u).length,
      0,
    ),
  }));
  assert.ok(
    budget.every(({ words }) => words <= 25),
    "Distinct exported excerpts exceed the per-source 25-word budget.",
  );
  const batch = RecordedBatch.parse({
    provider_run_id: original.provider_run_id,
    provider_jobs: original.provider_jobs,
    recorded_at: original.recorded_at,
    evidence_mode: "recorded_live_plus_local_primary_source_review",
    traces,
    excerpts,
    local_review: review.local_review,
  });
  const output = JSON.stringify(batch, null, 2) + "\n";
  if (checkOnly)
    assert.equal(
      await readFile(outputPath, "utf8"),
      output,
      "Reviewed artifact drifted.",
    );
  else await writeFile(outputPath, output);
  console.log(
    JSON.stringify({
      operation: checkOnly ? "checked" : "generated",
      schema: "RecordedBatch.parse",
      traces: batch.traces.length,
      provider_requests_started: 0,
      original_batch_sha256: originalHash,
      maximum_distinct_excerpt_words_per_source: Math.max(
        ...budget.map(({ words }) => words),
      ),
      complete_earliest_origin_traces_claimed: 0,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Artifact review failed.",
  );
  process.exitCode = 1;
});
