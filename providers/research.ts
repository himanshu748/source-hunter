import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import type {
  PoolLedger,
  PrivateApiKey,
  Reservation,
} from "../shared/index.js";
import { observePrice, providerJson, ProviderError } from "./pricing.js";

const root = "https://agent.tinyfish.ai";
const Status = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
const Created = z.object({ research_run_id: z.uuid() });
const Report = z.object({
  result: z.string().max(1500000),
  citations: z.array(z.string().max(4000)).max(1000),
  termination_reason: z.string().max(100).optional(),
});
const Saved = z.object({
  research_run_id: z.uuid(),
  status: Status,
  deep_result: Report.nullish(),
});
const Cancellation = z.object({ research_run_id: z.uuid(), status: Status });
const terminal = (s: z.infer<typeof Status>) =>
  !["QUEUED", "RUNNING"].includes(s);
export interface ResearchReceipt {
  provider: "tinyfish-research";
  mode: "deep";
  research_run_id: string;
  reservation_id: string;
  reserved_microusd: number;
  status: z.infer<typeof Status>;
  recorded_at: string;
  result: string | null;
  citations: string[];
  termination_reason: string | null;
  warnings: string[];
}

/** One flat-price run. No follow-up, Max escalation, or automatic job retry. */
export async function runDeepResearch(args: {
  controls: { pool: PoolLedger; key: PrivateApiKey };
  bounty: "source-hunter" | "compliance-map";
  query: string;
  requestId?: string;
  signal?: AbortSignal | undefined;
  policyId?: string;
  pollMs?: number;
  deadlineMs?: number;
  request?: typeof fetch | undefined;
  onStarted?: (receipt: {
    research_run_id: string;
    reservation: Reservation;
  }) => Promise<void>;
  onProgress?: (status: string) => void;
}): Promise<ResearchReceipt> {
  if (!args.query.trim() || args.query.length > 10000)
    throw new ProviderError(
      "INVALID_INPUT",
      "Research queries must contain 1–10,000 characters.",
    );
  const pollMs = args.pollMs ?? 10000,
    deadlineMs = args.deadlineMs ?? 25 * 60 * 1000;
  if (
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 30000 ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 45 * 60 * 1000
  )
    throw new ProviderError("INVALID_INPUT", "Unsupported polling bounds.");
  const { pool, key } = args.controls;
  const policy = pool.getPolicy(args.policyId ?? "research-deep");
  if (
    policy.unit !== "run" ||
    policy.max_units_per_operation !== 1 ||
    policy.max_unit_price_microusd < 2000000 ||
    policy.enforcement.mechanism !== "fixed_request_contract"
  )
    throw new ProviderError(
      "INVALID_INPUT",
      "Research requires an approved single Deep run policy.",
    );
  const pricing = await observePrice({
    key,
    policy,
    meter: { label: "TinyFish Research (Deep)", per: "run" },
    signal: args.signal,
    request: args.request,
  });
  const reservation = await pool.reserve(
    {
      request_id: args.requestId ?? randomUUID(),
      bounty_id: args.bounty,
      policy_id: policy.id,
      pricing,
    },
    args.signal,
  );
  if (args.signal?.aborted) {
    await pool.cancelBeforeDispatch(reservation.id);
    throw new ProviderError("CANCELLED", "Cancelled before Research dispatch.");
  }
  let runId: string | undefined;
  let finalized = false;
  const api = (
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) =>
    providerJson({
      key,
      url: root + path,
      method,
      ...(body === undefined ? {} : { body }),
      signal,
      request: args.request,
    });
  const finish = async (
    saved: z.infer<typeof Saved>,
  ): Promise<ResearchReceipt> => {
    if (!terminal(saved.status))
      throw new ProviderError("PROVIDER_FAILURE", "Research is still active.");
    await pool.recordTerminal(
      reservation.id,
      saved.status === "COMPLETED"
        ? "success"
        : saved.status === "CANCELLED"
          ? "cancelled"
          : "failure",
      saved.status === "COMPLETED" ? 1 : 0,
    );
    finalized = true;
    const warnings: string[] = [];
    if (saved.status !== "COMPLETED")
      warnings.push("Research did not produce a completed report.");
    if (saved.status === "COMPLETED" && !saved.deep_result)
      warnings.push(
        "Provider marked the run completed but supplied no validated report.",
      );
    const reason = saved.deep_result?.termination_reason ?? null;
    if (reason !== "planner_done")
      warnings.push(
        reason
          ? `Research termination: ${reason}. Review completeness.`
          : "Research termination metadata is absent.",
      );
    return {
      provider: "tinyfish-research",
      mode: "deep",
      research_run_id: saved.research_run_id,
      reservation_id: reservation.id,
      reserved_microusd: reservation.reserved_microusd,
      status: saved.status,
      recorded_at: new Date().toISOString(),
      result: saved.deep_result?.result ?? null,
      citations: saved.deep_result?.citations ?? [],
      termination_reason: reason,
      warnings,
    };
  };
  try {
    const created = Created.safeParse(
      await api(
        "/v1/automation/run-research-async",
        "POST",
        {
          query: args.query,
          mode: "deep",
          stream: false,
          output_language: "en",
        },
        args.signal,
      ),
    );
    if (!created.success)
      throw new ProviderError(
        "PROVIDER_FAILURE",
        "Research acceptance did not include a valid run ID. No start retry is allowed.",
      );
    runId = created.data.research_run_id;
    await pool.markStarted(reservation.id, runId);
    await args.onStarted?.({ research_run_id: runId, reservation });
    const deadline = Date.now() + deadlineMs;
    while (true) {
      if (args.signal?.aborted || Date.now() >= deadline)
        throw new ProviderError(
          args.signal?.aborted ? "CANCELLED" : "PROVIDER_TIMEOUT",
          "Research observation ended; cancellation is being verified.",
        );
      const saved = Saved.safeParse(
        await api(`/v1/research-run/${runId}`, "GET", undefined, args.signal),
      );
      if (!saved.success || saved.data.research_run_id !== runId)
        throw new ProviderError(
          "PROVIDER_FAILURE",
          "Research status did not match its accepted run.",
        );
      args.onProgress?.(saved.data.status);
      if (terminal(saved.data.status)) return await finish(saved.data);
      await pause(
        Math.min(pollMs, Math.max(1, deadline - Date.now())),
        undefined,
        args.signal ? { signal: args.signal } : undefined,
      );
    }
  } catch (error) {
    if (finalized) throw error;
    if (!runId) {
      // Explicit pre-run HTTP rejection cannot create a job; network/5xx/lost ID can.
      if (
        error instanceof ProviderError &&
        error.httpStatus &&
        [400, 401, 402, 403, 404, 429].includes(error.httpStatus)
      )
        await pool.recordTerminal(reservation.id, "failure", 0);
      else await pool.recordUncertain(reservation.id);
    } else {
      try {
        const cancelled = Cancellation.safeParse(
          await api(`/v1/research-run/${runId}/cancel`, "POST"),
        );
        if (
          !cancelled.success ||
          cancelled.data.research_run_id !== runId ||
          !terminal(cancelled.data.status)
        )
          throw new Error("unconfirmed");
        const saved = Saved.safeParse(await api(`/v1/research-run/${runId}`));
        if (
          !saved.success ||
          saved.data.research_run_id !== runId ||
          !terminal(saved.data.status)
        )
          throw new Error("unconfirmed");
        // Completion racing cancellation is retained as a paid completed run.
        return await finish(saved.data);
      } catch {
        await pool.recordUncertain(reservation.id);
      }
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_FAILURE",
      "Research did not finish. See the private shared ledger; no job was repeated.",
    );
  }
}
