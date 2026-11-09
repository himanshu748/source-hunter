import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type PoolLedger,
  type PrivateApiKey,
  assertNotCancelled,
} from "../shared/index.js";
import { observePrice, providerJson, ProviderError } from "./pricing.js";

export type FetchPricingTier = "hobby" | "builder";
/** The caller must establish its account tier; rates never select a tier for us. */
export function fetchMeter(pricingTier?: FetchPricingTier): {
  label: string;
  per: "url";
} {
  if (pricingTier === undefined) return { label: "TinyFish Fetch", per: "url" };
  if (pricingTier !== "hobby" && pricingTier !== "builder")
    throw new ProviderError(
      "INVALID_INPUT",
      "Fetch pricing tier must be hobby or builder when supplied.",
    );
  return {
    label:
      pricingTier === "hobby"
        ? "TinyFish Fetch (Hobby)"
        : "TinyFish Fetch (Builder)",
    per: "url",
  };
}

const Result = z.object({
  url: z.string().max(2000),
  final_url: z.string().max(2000),
  text: z.string().max(500000),
  format: z.literal("html"),
  unmatched_selectors: z.array(z.string().max(1000)).optional(),
});
const Failure = z.object({
  url: z.string().max(2000),
  error: z.enum([
    "target_http_error",
    "page_not_found",
    "target_unreachable",
    "timeout",
    "bot_blocked",
    "empty_content",
    "login_required",
    "content_too_large",
    "invalid_url",
    "invalid_redirect_url",
    "proxy_error",
    "conditional_unsupported",
    "selector_not_matched",
    "selector_unsupported",
  ]),
  status: z.number().int().min(100).max(599).optional(),
});
const Envelope = z.object({
  results: z.array(Result).max(1),
  errors: z.array(Failure).max(1),
});
export type FetchedHtml = {
  html: string;
  source_url: string;
  final_url: string;
  observed_at: string;
  reservation_id: string;
};
/** Safe terminal metadata; never raw provider error text or a key-bearing request. */
export class FetchSourceError extends ProviderError {
  constructor(
    readonly sourceCode: string,
    readonly sourceHttpStatus: number | null,
    readonly reservationId: string,
    readonly observedAt: string,
  ) {
    super(
      "SOURCE_FAILURE",
      "The bounded source request returned a terminal failure.",
    );
  }
}

/** Each call is one fresh URL, one shared reservation and zero automatic retries. */
export async function fetchHtml(args: {
  pool: PoolLedger;
  key: PrivateApiKey;
  bountyId: string;
  policyId: string;
  url: string;
  /** Omit for reviewed non-HTML sources; supplied selectors remain bounded. */
  selectors?: readonly string[] | undefined;
  assertAllowed: (url: string) => void;
  pricingTier?: FetchPricingTier;
  signal?: AbortSignal | undefined;
  request?: typeof fetch | undefined;
}): Promise<FetchedHtml> {
  assertNotCancelled(args.signal);
  const meter = fetchMeter(args.pricingTier);
  args.assertAllowed(args.url);
  const suppliedSelectors = args.selectors;
  if (
    suppliedSelectors !== undefined &&
    (!Array.isArray(suppliedSelectors) ||
      !suppliedSelectors.length ||
      suppliedSelectors.length > 20 ||
      suppliedSelectors.some(
        (s) => typeof s !== "string" || !s || s.length > 1000,
      ))
  )
    throw new ProviderError(
      "INVALID_INPUT",
      "Use a bounded, reviewed selector list.",
    );
  const selectors =
    suppliedSelectors === undefined ? undefined : [...suppliedSelectors];
  const policy = args.pool.getPolicy(args.policyId);
  if (
    policy.unit !== "url" ||
    policy.max_units_per_operation !== 1 ||
    policy.enforcement.mechanism !== "fixed_request_contract" ||
    !policy.enforcement.source_url.startsWith(
      "https://docs.tinyfish.ai/fetch-api/",
    )
  )
    throw new ProviderError(
      "INVALID_POLICY",
      "Fetch requires the bound one-URL fixed-request policy.",
    );
  const pricing = await observePrice({
    key: args.key,
    policy,
    meter,
    signal: args.signal,
    request: args.request,
  });
  const reservation = await args.pool.reserve(
    {
      request_id: randomUUID(),
      bounty_id: args.bountyId,
      policy_id: policy.id,
      pricing,
    },
    args.signal,
  );
  let dispatched = false;
  let terminal = false;
  try {
    assertNotCancelled(args.signal);
    const request: typeof fetch = (input, init) => {
      // This is the last synchronous cancellation check before calling the transport.
      assertNotCancelled(args.signal);
      dispatched = true;
      return (args.request ?? fetch)(input, init);
    };
    const raw = await providerJson({
      key: args.key,
      url: "https://api.fetch.tinyfish.ai/",
      method: "POST",
      body: {
        urls: [args.url],
        format: "html",
        links: false,
        image_links: false,
        ttl: 0,
        per_url_timeout_ms: 45000,
        ...(selectors === undefined ? {} : { include_selectors: selectors }),
        purpose:
          "Record a finite public-source observation for an auditable evidence workflow.",
      },
      request,
      signal: args.signal,
      timeoutMs: 60000,
      maxBytes: 1000000,
    });
    const parsed = Envelope.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.results.length + parsed.data.errors.length !== 1
    )
      throw new ProviderError(
        "PROVIDER_CONTRACT_CHANGED",
        "Fetch did not return exactly one bounded URL outcome.",
      );
    const outcome = parsed.data.results[0] ?? parsed.data.errors[0]!;
    if (outcome.url !== args.url)
      throw new ProviderError(
        "PROVIDER_CONTRACT_CHANGED",
        "Fetch returned an unexpected source identity.",
      );
    await args.pool.recordTerminal(
      reservation.id,
      parsed.data.errors.length ? "failure" : "success",
      1,
    );
    terminal = true;
    if (parsed.data.errors.length) {
      const failed = parsed.data.errors[0]!;
      throw new FetchSourceError(
        failed.error,
        failed.status ?? null,
        reservation.id,
        new Date().toISOString(),
      );
    }
    const result = parsed.data.results[0]!;
    try {
      args.assertAllowed(result.final_url);
    } catch {
      throw new ProviderError(
        "REDIRECT_REJECTED",
        "The final source URL is outside the reviewed allowlist.",
      );
    }
    if (result.final_url !== args.url)
      throw new ProviderError(
        "REDIRECT_REJECTED",
        "The final source URL differs from the reviewed page.",
      );
    if (
      result.unmatched_selectors?.length ||
      Buffer.byteLength(result.text) > 500000 ||
      !result.text.trim()
    )
      throw new ProviderError(
        "SOURCE_STRUCTURE_CHANGED",
        "The selected source sections are incomplete or oversized.",
      );
    return {
      html: result.text,
      source_url: args.url,
      final_url: result.final_url,
      observed_at: new Date().toISOString(),
      reservation_id: reservation.id,
    };
  } catch (error) {
    if (!terminal) {
      if (
        dispatched &&
        error instanceof ProviderError &&
        error.code === "RESPONSE_TOO_LARGE" &&
        error.httpStatus !== undefined &&
        error.httpStatus >= 200 &&
        error.httpStatus <= 299
      ) {
        await args.pool.recordTerminal(reservation.id, "failure", 1);
      } else if (dispatched) await args.pool.recordUncertain(reservation.id);
      else await args.pool.cancelBeforeDispatch(reservation.id);
    }
    // Do not forward request objects, raw provider bodies or credential-bearing errors.
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      dispatched ? "PROVIDER_UNCERTAIN" : "CANCELLED",
      dispatched
        ? "The source operation could not be reconciled; the aggregate pool is halted."
        : "Cancelled before source dispatch.",
    );
  }
}
