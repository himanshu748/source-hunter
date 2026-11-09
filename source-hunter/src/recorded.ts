import { readFile } from "node:fs/promises";
import { z } from "zod";
import { publicUrl } from "../../providers/public-url.js";
import { Selection, type SelectionInput } from "./core.js";

const Url = z.string().max(4000).transform(publicUrl);
const Note = z.string().max(8000);
const Check = z.string().min(1).max(100);
const Hop = z.object({
  url: Url,
  title: z.string().min(1).max(300),
  role: z.enum(["selected_page", "intermediary", "primary_candidate"]),
  quote: z.string().max(1500),
  relationship_to_next: z.string().max(1000).nullable(),
  excerpt_shortened: z.boolean().optional(),
  quote_check: Check,
  link_to_next: Check.optional(),
  checked_at: z.union([z.iso.datetime(), z.iso.date()]).nullable().optional(),
  html_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  fetch_reservation_id: z.uuid().nullable().optional(),
  check_method: z.string().max(150).optional(),
  publication_date: z.string().max(100).nullable().optional(),
});
const Evidence = z.object({
  source_url: Url,
  stance: z.enum(["supports", "refutes", "clarifies"]),
  quote_ref: z.string().max(300).nullable(),
  quote_check: Check,
});
const DateEvidence = z.object({
  kind: z.string().min(1).max(100),
  value: z.string().max(100).nullable(),
  precision: z.string().min(1).max(30),
  source_url: Url,
  quote_ref: z.string().max(300).nullable(),
  check: Check,
});
const LocalReview = z.object({
  checked_at: z.iso.datetime(),
  method: z.string().min(1).max(300),
  summary: z.string().max(4000),
  original_batch_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  limitations: z.array(Note).max(30).default([]),
  provider_requests_started: z.literal(0),
});
const Trace = z.object({
  id: z.string().min(1).max(100),
  selection: Selection,
  context: z.string().max(4000),
  selection_quote_check: Check,
  selection_url_aliases: z.array(Url).max(5).optional(),
  chain: z.object({
    selection: Selection,
    provider_run_id: z.uuid(),
    recorded_at: z.iso.datetime(),
    verification: Check,
    status: z.enum(["candidate", "unresolved"]),
    summary: z.string().max(4000),
    hops: z.array(Hop).max(8),
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
    proposed_label: Check.optional(),
    target: z.string().max(100),
    reason: z.string().max(4000),
    research_explanation: z.string().max(8000).optional(),
    scope: z.string().max(200).optional(),
    check: Check,
    evidence: z.array(Evidence).max(12),
  }),
  dates: z.array(DateEvidence).max(15),
  earliest_source_status: Check,
  primary_source_status: Check.optional(),
  local_review: LocalReview.optional(),
});
const Excerpt = z.object({
  ref: z.string().min(1).max(300),
  url: Url,
  quote: z.string().min(1).max(1500),
});
export const RecordedBatch = z
  .object({
    provider_run_id: z.uuid(),
    recorded_at: z.iso.datetime(),
    provider_jobs: z.literal(1),
    evidence_mode: z.string().min(1).max(100),
    traces: z.array(Trace).min(1).max(5),
    excerpts: z.array(Excerpt).max(100),
    local_review: LocalReview.optional(),
  })
  .superRefine((batch, ctx) => {
    const ids = new Set<string>();
    const identities = new Set<string>();
    for (const trace of batch.traces) {
      const traceIdentities = [
        trace.selection.page_url,
        ...(trace.selection_url_aliases ?? []),
      ].map((url) => url + "\n" + normalizeSelection(trace.selection.text));
      if (
        ids.has(trace.id) ||
        traceIdentities.some((identity) => identities.has(identity))
      )
        ctx.addIssue({
          code: "custom",
          message: "Duplicate recorded selection.",
        });
      ids.add(trace.id);
      traceIdentities.forEach((identity) => identities.add(identity));
      if (
        trace.chain.provider_run_id !== batch.provider_run_id ||
        trace.chain.recorded_at !== batch.recorded_at ||
        trace.chain.selection.page_url !== trace.selection.page_url ||
        normalizeSelection(trace.chain.selection.text) !==
          normalizeSelection(trace.selection.text)
      )
        ctx.addIssue({
          code: "custom",
          message: "Recorded trace identity does not match its batch.",
        });
      for (const item of trace.assessment.evidence) {
        if (item.quote_check === "matched" && item.quote_ref === null)
          ctx.addIssue({
            code: "custom",
            message: "Matched evidence needs an excerpt reference.",
          });
        const hopReference = trace.chain.hops.some(
          (hop, index) =>
            item.quote_ref === `${trace.id}.chain.hops.${index}.quote` &&
            hop.url === item.source_url &&
            hop.quote_check === "matched",
        );
        if (
          item.quote_ref !== null &&
          !hopReference &&
          !batch.excerpts.some(
            (e) =>
              e.ref === item.quote_ref &&
              e.ref.startsWith(trace.id + ".") &&
              e.url === item.source_url,
          )
        ) {
          if (item.quote_check === "matched")
            ctx.addIssue({
              code: "custom",
              message: "Matched evidence has no corresponding excerpt.",
            });
        }
      }
    }
  });
export type RecordedSourceBatch = z.infer<typeof RecordedBatch>;

export function normalizeSelection(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** Exact text and public source identity; never substitute a related claim. */
export function matchingRecordedTrace(
  batch: RecordedSourceBatch,
  raw: SelectionInput,
) {
  const selection = Selection.parse(raw);
  return batch.traces.find(
    (trace) =>
      normalizeSelection(trace.selection.text) ===
        normalizeSelection(selection.text) &&
      [
        trace.selection.page_url,
        ...(trace.selection_url_aliases ?? []),
      ].includes(selection.page_url),
  );
}

/** Invalid reviewed files fail closed. Only a missing file permits the original. */
export async function readRecordedBatch(
  directory = new URL("../evidence/", import.meta.url),
): Promise<RecordedSourceBatch> {
  let bytes: string;
  try {
    bytes = await readFile(new URL("reviewed-batch.json", directory), "utf8");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    bytes = await readFile(new URL("live-batch.json", directory), "utf8");
  }
  return RecordedBatch.parse(JSON.parse(bytes));
}
