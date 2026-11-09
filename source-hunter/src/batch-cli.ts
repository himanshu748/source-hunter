import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadControlsFromEnvironment } from "../../shared/index.js";
import { runDeepResearch } from "../../providers/research.js";
import { fetchHtml } from "../../providers/fetch.js";
import { publicUrl } from "../../providers/public-url.js";
import {
  SOURCE_BATCH_SELECTIONS,
  sourceBatchQuery,
  projectSourceBatch,
  corroborateSourceBatch,
} from "./batch.js";
const safeCode = (error: unknown) => {
  const raw =
    error && typeof error === "object" && "code" in error
      ? error.code
      : "BATCH_FAILED";
  return typeof raw === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(raw)
    ? raw
    : "BATCH_FAILED";
};
async function durable(path: string, value: unknown, replace = false) {
  const temp = join(dirname(path), `.batch-${randomUUID()}.tmp`),
    file = await open(replace ? temp : path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  if (replace) await rename(temp, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function main() {
  const [flag, output, ...extra] = process.argv.slice(2);
  if (
    flag !== "--output" ||
    !output ||
    extra.length ||
    !isAbsolute(output) ||
    resolve(output) !== output
  )
    throw new Error("Use --output with a new absolute private directory.");
  const controls = await loadControlsFromEnvironment();
  await mkdir(output, { mode: 0o700 });
  const query = sourceBatchQuery();
  if (query.length > 10000) throw new Error("BATCH_QUERY_TOO_LONG");
  await durable(join(output, "request.json"), {
    mode: "one_deep_batch",
    inputs: SOURCE_BATCH_SELECTIONS,
    query,
    created_at: new Date().toISOString(),
    maximum_provider_jobs: 1,
    maximum_fetch_url_checks: 25,
  });
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let lastStatus = "";
  try {
    const receipt = await runDeepResearch({
      controls,
      bounty: "source-hunter",
      query,
      signal: controller.signal,
      onStarted: async (accepted) => {
        await durable(join(output, "accepted.json"), accepted);
        console.log(
          JSON.stringify({
            event: "accepted",
            provider_run_id: accepted.research_run_id,
            provider_jobs: 1,
          }),
        );
      },
      onProgress: (status) => {
        if (status !== lastStatus) {
          lastStatus = status;
          console.log(JSON.stringify({ event: "progress", status }));
        }
      },
    });
    await durable(join(output, "research-receipt.json"), receipt);
    const projected = projectSourceBatch(receipt);
    await durable(join(output, "projected.json"), projected);
    const matrix = await corroborateSourceBatch(
      projected,
      async (url, signal) => {
        try {
          const result = await fetchHtml({
            ...controls,
            bountyId: "source-hunter",
            policyId: "fetch-public",
            url,
            selectors: ["body"],
            assertAllowed: (candidate) => {
              if (publicUrl(candidate) !== url)
                throw new Error("SOURCE_NOT_ALLOWED");
            },
            signal,
          });
          await durable(
            join(
              output,
              `page-${createHash("sha256").update(url).digest("hex")}.json`,
            ),
            result,
          );
          return result;
        } catch (error) {
          const status = await controls.pool.status();
          if (
            status.halted ||
            [
              "PRICING_CHANGED",
              "AUTHENTICATION",
              "AUTHORIZATION_REQUIRED",
              "PROVIDER_QUOTA",
              "ALLOWANCE_EXHAUSTED",
              "HALTED",
              "BUSY",
              "STATE_FAILURE",
            ].includes(safeCode(error))
          )
            controller.abort();
          throw error;
        }
      },
      {
        maximumUrls: receipt.status === "COMPLETED" ? 25 : 0,
        signal: controller.signal,
      },
    );
    const artifact = {
      ...matrix,
      provider_status: receipt.status,
      reserved_microusd: receipt.reserved_microusd,
      raw_research_receipt_sha256: createHash("sha256")
        .update(await readFile(join(output, "research-receipt.json")))
        .digest("hex"),
      evidence_mode: "recorded_live",
      execution_note:
        "One actual Deep Research batch. Exact-page Fetch checks are bounded to25, deduplicated and never retried. Matched quotes are not an earliest-source guarantee.",
    };
    await durable(join(output, "live-batch.json"), artifact);
    const target = resolve("source-hunter/evidence/live-batch.json");
    await durable(target, artifact);
    console.log(
      JSON.stringify({
        event: "completed",
        provider_run_id: artifact.provider_run_id,
        provider_jobs: 1,
        status: receipt.status,
        page_checks: artifact.page_checks,
        trace_assessments: artifact.traces.map((trace) => ({
          id: trace.id,
          chain_status: trace.chain.status,
          assessment: trace.assessment.label,
          verification: trace.chain.verification,
        })),
        reserved_microusd: receipt.reserved_microusd,
      }),
    );
    if (receipt.status !== "COMPLETED" || controller.signal.aborted)
      process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: safeCode(error),
      message:
        "The one-job batch stopped. Inspect saved acceptance and the shared ledger; no paid repeat was made.",
    }),
  );
  process.exitCode = 1;
});
