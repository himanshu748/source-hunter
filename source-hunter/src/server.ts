import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  loadControlsFromEnvironment,
  ControlError,
} from "../../shared/index.js";
import { runDeepResearch } from "../../providers/research.js";
import { fetchHtml, fetchMeter } from "../../providers/fetch.js";
import { observePrice } from "../../providers/pricing.js";
import { Selection } from "./core.js";
import { freshSourceQuery, corroborateFreshSource } from "./fresh.js";
import { readRecordedBatch, matchingRecordedTrace } from "./recorded.js";
import {
  createInvestigation,
  consumeResume,
  recordResumeAvailability,
  writeInvestigationFile,
  fetchPricingTier,
} from "./recovery.js";
const ResumeRequest = z
  .object({ selection: Selection, investigation_id: z.uuid() })
  .strict();

const port = Number(process.env.SOURCE_HUNTER_PORT ?? "4388");
if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535)))
  throw new Error("Invalid local port");
let origin = `http://127.0.0.1:${port}`;
const extension = process.env.SOURCE_HUNTER_EXTENSION_ID;
if (extension && !/^[a-p]{32}$/.test(extension))
  throw new Error("Invalid SOURCE_HUNTER_EXTENSION_ID");
const root = fileURLToPath(new URL("../web/", import.meta.url));
let busy = false;
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function allowed(req: IncomingMessage) {
  return (
    req.headers.host === new URL(origin).host &&
    (req.headers.origin === origin ||
      (!!extension && req.headers.origin === `chrome-extension://${extension}`))
  );
}
async function input(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > 10000) throw new Error("oversized");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (req.headers.host !== new URL(origin).host) {
    json(res, 403, { message: "Unexpected local host." });
    return;
  }
  const sharedAssets: Record<string, [URL, string]> = {
    "/assets/manrope.woff2": [
      new URL("../../ui/assets/manrope.woff2", import.meta.url),
      "font/woff2",
    ],
    "/assets/dmsans.woff2": [
      new URL("../../ui/assets/dmsans.woff2", import.meta.url),
      "font/woff2",
    ],
    "/downloads/source-hunter-extension.zip": [
      new URL("../../ui/assets/source-hunter-extension.zip", import.meta.url),
      "application/zip",
    ],
  };
  const asset = sharedAssets[req.url ?? ""];
  if (req.method === "GET" && asset) {
    try {
      res.writeHead(200, {
        "Content-Type": asset[1],
        "Cache-Control": req.url?.endsWith(".zip")
          ? "no-store"
          : "public, max-age=3600",
      });
      res.end(await readFile(asset[0]));
    } catch {
      json(res, 404, { message: "Asset not available." });
    }
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    if (allowed(req)) {
      res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin));
      res.setHeader("Vary", "Origin");
    }
    let count = 0;
    try {
      count = (await readRecordedBatch()).traces.length;
    } catch {
      /* Explicitly unavailable. */
    }
    json(res, 200, {
      service: "source-hunter",
      mode:
        process.env.BOUNTY_POOL_LIVE === "1" ? "live_enabled" : "recorded_only",
      extension_configured: !!extension,
      recorded_trace_count: count,
      recorded_available: count > 0,
      provider_health_checked: false,
      provider_requests_started: 0,
    });
    return;
  }
  if (req.method === "GET" && req.url === "/recorded-traces.json") {
    try {
      const batch = await readRecordedBatch();
      json(res, 200, {
        ...batch,
        mode: "recorded_live_batch",
        provider_requests_started: 0,
      });
    } catch {
      json(res, 503, {
        code: "RECORDED_UNAVAILABLE",
        message: "The recorded evidence is unavailable or invalid.",
      });
    }
    return;
  }
  if (req.url?.startsWith("/api/")) {
    if (!allowed(req)) {
      json(res, 403, {
        message: "This origin is not authorized to use the local service.",
      });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin));
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }
    if (
      ![
        "/api/source-hunter",
        "/api/source-hunter/resume",
        "/api/source-hunter/recorded-match",
      ].includes(req.url ?? "") ||
      req.method !== "POST" ||
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      json(res, 404, { message: "Unknown API operation." });
      return;
    }
    if (req.url === "/api/source-hunter/recorded-match") {
      let selection;
      try {
        selection = Selection.parse(await input(req));
      } catch {
        json(res, 400, {
          code: "INVALID_INPUT",
          message: "Use a public page and a 10–1,000 character selection.",
        });
        return;
      }
      try {
        const batch = await readRecordedBatch();
        const trace = matchingRecordedTrace(batch, selection);
        if (!trace) {
          json(res, 404, {
            code: "NO_RECORDED_MATCH",
            message:
              "No saved investigation matches this exact selection and public page. No new research was started.",
          });
          return;
        }
        json(res, 200, {
          mode: "recorded_research",
          provider_run_id: batch.provider_run_id,
          recorded_at: batch.recorded_at,
          provider_requests_started: 0,
          trace,
          excerpts: batch.excerpts.filter((e) =>
            e.ref.startsWith(trace.id + "."),
          ),
          ...(batch.local_review ? { local_review: batch.local_review } : {}),
        });
      } catch {
        json(res, 503, {
          code: "RECORDED_UNAVAILABLE",
          message:
            "The recorded evidence is unavailable or invalid. No new research was started.",
        });
      }
      return;
    }
    if (busy) {
      json(res, 409, {
        message:
          "A local research run is already active. Wait for its receipt.",
      });
      return;
    }
    busy = true;
    const resuming = req.url === "/api/source-hunter/resume";
    let investigationId: string | undefined;
    let controls:
      Awaited<ReturnType<typeof loadControlsFromEnvironment>> | undefined;
    const privateBase = resolve(
      process.env.BOUNTY_RESEARCH_OUTPUT_DIRECTORY ??
        join(process.cwd(), ".private", "source-hunter"),
    );
    try {
      const body = await input(req);
      const continuation = resuming ? ResumeRequest.parse(body) : null;
      let selection = continuation?.selection ?? Selection.parse(body);
      const id = continuation?.investigation_id ?? randomUUID();
      investigationId = id;
      const pricingTier = fetchPricingTier();
      const query = freshSourceQuery(selection, "fresh-" + id);
      const currentControls = await loadControlsFromEnvironment();
      controls = currentControls;
      // Establish the reader's current price before buying Research or consuming
      // a recovery receipt. Each page still receives its own fresh preflight.
      await observePrice({
        key: currentControls.key,
        policy: currentControls.pool.getPolicy("fetch-public"),
        meter: fetchMeter(pricingTier),
      });
      let output: string;
      let receipt;
      if (continuation) {
        const resumed = await consumeResume(
          privateBase,
          id,
          selection,
          await currentControls.pool.status(),
        );
        output = resumed.directory;
        selection = resumed.input.selection;
        receipt = resumed.receipt;
      } else {
        const created = await createInvestigation(
          privateBase,
          id,
          selection,
          await currentControls.pool.status(),
        );
        output = created.directory;
        receipt = await runDeepResearch({
          controls: currentControls,
          bounty: "source-hunter",
          query,
          onStarted: async (accepted) =>
            writeInvestigationFile(output, "accepted.json", accepted),
        });
        await writeInvestigationFile(output, "research-receipt.json", receipt);
      }
      let pageCount = 0;
      const result = await corroborateFreshSource(
        receipt,
        selection,
        async (url, signal) => {
          const page = await fetchHtml({
            ...currentControls,
            bountyId: "source-hunter",
            policyId: "fetch-public",
            url,
            selectors: /\.(?:pdf|csv)$/iu.test(new URL(url).pathname)
              ? undefined
              : ["body"],
            ...(pricingTier ? { pricingTier } : {}),
            assertAllowed: (candidate) => {
              if (candidate !== url) throw new Error("REDIRECT_REJECTED");
            },
            signal,
          });
          try {
            await writeInvestigationFile(
              output,
              `page-${++pageCount}.json`,
              page,
            );
          } catch {
            throw new ControlError(
              "STATE_FAILURE",
              "The private source receipt could not be persisted.",
            );
          }
          return page;
        },
        { id: "fresh-" + id, maximumUrls: 10 },
      );
      await writeInvestigationFile(output, "chain.json", {
        ...result,
        investigation_id: id,
        ...(resuming
          ? { resumed_research: true, new_research_jobs_started: 0 }
          : {}),
      });
      json(res, 200, {
        ...result,
        investigation_id: id,
        ...(resuming
          ? { resumed_research: true, new_research_jobs_started: 0 }
          : {}),
      });
    } catch (error) {
      const rawCode =
        error && typeof error === "object" && "code" in error
          ? error.code
          : "INVALID_INPUT";
      const code =
        typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(rawCode)
          ? rawCode
          : "INVALID_INPUT";
      let resumeAvailable = false;
      if (!resuming && controls && investigationId) {
        try {
          resumeAvailable = await recordResumeAvailability(
            privateBase,
            investigationId,
            await controls.pool.status(),
            code,
          );
        } catch {
          /* State cannot establish a safe continuation. */
        }
      }
      json(res, code === "LIVE_DISABLED" ? 503 : 400, {
        code,
        ...(investigationId
          ? {
              investigation_id: investigationId,
              resume_available: resumeAvailable,
            }
          : {}),
        message:
          code === "LIVE_DISABLED"
            ? "Live research is disabled. Start the server with the reviewed shared grant to trace a selection."
            : "The trace did not complete. The shared ledger and private receipts retain its status; no run was repeated.",
      });
    } finally {
      busy = false;
    }
    return;
  }
  const paths: Record<string, [string, string]> = {
    "/": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"],
  };
  const target = paths[req.url ?? ""];
  if (req.method !== "GET" || !target) {
    json(res, 404, { message: "Page not found." });
    return;
  }
  try {
    res.writeHead(200, {
      "Content-Type": target[1],
      "Cache-Control": "no-store",
    });
    res.end(await readFile(join(root, target[0])));
  } catch {
    res.destroy();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.timeout = 0;
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local server address");
  origin = `http://127.0.0.1:${address.port}`;
  console.log(
    `Source Hunter: ${origin} (live ${process.env.BOUNTY_POOL_LIVE === "1" ? "enabled with shared controls" : "disabled"})`,
  );
});
