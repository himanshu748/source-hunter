import { z } from "zod";
import type {
  EndpointPolicy,
  PricingQuote,
  PrivateApiKey,
} from "../shared/index.js";

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Reject fractional micro-dollars rather than rounding the cost down. */
export function usdToMicro(value: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new ProviderError(
      "PRICING_UNAVAILABLE",
      "USD pricing must be an unsigned decimal.",
    );
  const [whole = "0", raw = ""] = value.split(".");
  const fraction = raw.replace(/0+$/, "");
  if (fraction.length > 6)
    throw new ProviderError(
      "PRICING_UNAVAILABLE",
      "Pricing exceeds supported precision.",
    );
  const amount =
    BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ProviderError(
      "PRICING_UNAVAILABLE",
      "Pricing exceeds the supported range.",
    );
  return Number(amount);
}

const origins = new Set([
  "https://agent.tinyfish.ai",
  "https://api.fetch.tinyfish.ai",
  "https://api.browser.tinyfish.ai",
]);

/** Fixed API origins, normal TLS, bounded JSON, and no raw provider-error disclosure. */
export async function providerJson(args: {
  key: PrivateApiKey;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  maxBytes?: number;
  request?: typeof fetch | undefined;
}): Promise<unknown> {
  const url = new URL(args.url);
  if (!origins.has(url.origin) || url.username || url.password || url.hash)
    throw new ProviderError(
      "INVALID_INPUT",
      "Unsupported provider API origin.",
    );
  if (args.signal?.aborted)
    throw new ProviderError("CANCELLED", "Cancelled before provider dispatch.");
  const timeout = args.timeoutMs ?? 20000,
    maximum = args.maxBytes ?? 2000000;
  if (
    !Number.isInteger(timeout) ||
    !Number.isInteger(maximum) ||
    timeout < 1 ||
    timeout > 60000 ||
    maximum < 1 ||
    maximum > 10000000
  )
    throw new ProviderError(
      "INVALID_INPUT",
      "Unsupported provider request bounds.",
    );
  const body = args.body === undefined ? undefined : JSON.stringify(args.body);
  if (body !== undefined && Buffer.byteLength(body) > 500000)
    throw new ProviderError(
      "INVALID_INPUT",
      "Provider request exceeds its byte bound.",
    );
  const signal = AbortSignal.any([
    ...(args.signal ? [args.signal] : []),
    AbortSignal.timeout(timeout),
  ]);
  let response: Response;
  try {
    response = await args.key.withValue((key) =>
      (args.request ?? fetch)(url.href, {
        method: args.method ?? "GET",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
        signal,
        redirect: "error",
      }),
    );
  } catch {
    throw new ProviderError(
      args.signal?.aborted
        ? "CANCELLED"
        : signal.aborted
          ? "PROVIDER_TIMEOUT"
          : "PROVIDER_FAILURE",
      "The bounded provider request did not complete. No automatic job retry was made.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(
      [401, 403].includes(response.status)
        ? "AUTHENTICATION"
        : [402, 429].includes(response.status)
          ? "PROVIDER_QUOTA"
          : "PROVIDER_FAILURE",
      `TinyFish returned HTTP ${response.status}; its error body was withheld.`,
      response.status,
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new ProviderError(
      "PROVIDER_FAILURE",
      "TinyFish returned no response body.",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ProviderError(
          "RESPONSE_TOO_LARGE",
          "Provider response exceeded its byte limit.",
          response.status,
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_TIMEOUT",
      "Provider response did not finish within its bound.",
    );
  }
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    if (args.key.withValue((value) => text.includes(value)))
      throw new ProviderError(
        "PROVIDER_FAILURE",
        "Credential material in a provider response was withheld.",
      );
    const decoded: unknown = JSON.parse(text);
    const containsCredential = args.key.withValue((secret) => {
      const pending: unknown[] = [decoded];
      let visited = 0;
      while (pending.length) {
        if (++visited > 100000)
          throw new Error("Provider object complexity bound");
        const value = pending.pop();
        if (typeof value === "string" && value.includes(secret)) return true;
        if (value && typeof value === "object")
          for (const [name, child] of Object.entries(value)) {
            if (name.includes(secret)) return true;
            pending.push(child);
          }
      }
      return false;
    });
    if (containsCredential)
      throw new Error("Decoded credential material withheld");
    return decoded;
  } catch {
    throw new ProviderError(
      "PROVIDER_FAILURE",
      "TinyFish returned invalid JSON.",
    );
  }
}

const Wallet = z.object({
  available_balance: z.string(),
  currency: z.literal("USD"),
  rates: z.object({
    meters: z
      .array(
        z.object({
          label: z.string().max(150),
          unit_amount: z.string().max(50),
          currency: z.literal("USD"),
          per: z.string().max(30),
        }),
      )
      .max(1000),
  }),
});

/** Fresh read-only wallet observation; daily free Research quota is never assumed. */
export async function observePrice(args: {
  key: PrivateApiKey;
  policy: Readonly<EndpointPolicy>;
  meter: { label: string; per: string };
  signal?: AbortSignal | undefined;
  request?: typeof fetch | undefined;
}): Promise<PricingQuote> {
  const parsed = Wallet.safeParse(
    await providerJson({
      key: args.key,
      url: "https://agent.tinyfish.ai/v1/wallet",
      signal: args.signal,
      request: args.request,
      timeoutMs: 10000,
      maxBytes: 100000,
    }),
  );
  if (!parsed.success)
    throw new ProviderError(
      "PRICING_UNAVAILABLE",
      "Wallet pricing metadata no longer matches its contract.",
    );
  const rows = parsed.data.rates.meters.filter(
    (m) => m.label === args.meter.label && m.per === args.meter.per,
  );
  if (rows.length !== 1 || args.policy.unit !== args.meter.per)
    throw new ProviderError(
      "PRICING_UNAVAILABLE",
      "Exactly one matching price and unit is required.",
    );
  const price = usdToMicro(rows[0]!.unit_amount);
  if (price > args.policy.max_unit_price_microusd)
    throw new ProviderError(
      "PRICING_CHANGED",
      "Provider pricing exceeds the approved policy ceiling.",
    );
  const balance = parsed.data.available_balance.startsWith("-")
    ? -1
    : usdToMicro(parsed.data.available_balance);
  const reserved =
    args.policy.max_units_per_operation * args.policy.max_unit_price_microusd;
  if (!Number.isSafeInteger(reserved) || balance < reserved)
    throw new ProviderError(
      "PROVIDER_QUOTA",
      "Existing funds do not cover this bounded reservation.",
    );
  const now = Date.now();
  return {
    policy_id: args.policy.id,
    currency: "USD",
    unit: args.policy.unit,
    unit_price_microusd: price,
    checked_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30000).toISOString(),
    evidence_url: "https://agent.tinyfish.ai/v1/wallet",
  };
}
