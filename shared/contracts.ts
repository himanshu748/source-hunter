import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ControlError } from "./errors.js";

const slug = z.string().regex(/^[a-z][a-z0-9._-]{2,63}$/);
const integer = z.number().int().nonnegative().max(1_000_000_000_000);
const instant = z.string().datetime({ offset: true });
const providerReference = z
  .string()
  .max(500)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        (u.hostname === "tinyfish.ai" ||
          u.hostname.endsWith(".tinyfish.ai") ||
          u.hostname === "tinyfish.io" ||
          u.hostname.endsWith(".tinyfish.io"))
      );
    } catch {
      return false;
    }
  }, "Use a public TinyFish documentation or control-plane URL without credentials or query parameters.");

export const EndpointPolicySchema = z
  .object({
    id: slug,
    unit: slug,
    max_units_per_operation: integer.min(1).max(100_000_000),
    max_unit_price_microusd: integer,
    max_operations: integer.min(1).max(10_000),
    max_active_operations: integer.min(1).max(3),
    enforcement: z
      .object({
        mechanism: z.enum(["provider_cap", "fixed_request_contract"]),
        source_url: providerReference,
        description: z.string().min(10).max(500),
      })
      .strict(),
  })
  .strict();

export const AuthorizationGrantSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("tinyfish"),
    pool_id: slug,
    grant_id: z.uuid(),
    authorized_at: instant,
    expires_at: instant,
    currency: z.literal("USD"),
    max_reserved_microusd: integer,
    max_concurrent_operations: integer.min(1).max(3),
    state_directory: z
      .string()
      .refine((p) => isAbsolute(p) && resolve(p) === p),
    key_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    allowed_bounties: z.array(slug).min(1).max(32),
    policies: z.array(EndpointPolicySchema).min(1).max(16),
  })
  .strict()
  .superRefine((grant, context) => {
    if (Date.parse(grant.expires_at) <= Date.parse(grant.authorized_at))
      context.addIssue({
        code: "custom",
        message: "Grant expiry must follow authorization.",
      });
    if (
      new Set(grant.allowed_bounties).size !== grant.allowed_bounties.length ||
      new Set(grant.policies.map((p) => p.id)).size !== grant.policies.length
    )
      context.addIssue({
        code: "custom",
        message: "Bounty and policy identities must be unique.",
      });
    if (grant.policies.reduce((sum, p) => sum + p.max_operations, 0) > 10_000)
      context.addIssue({
        code: "custom",
        message: "Aggregate operation count exceeds the ledger bound.",
      });
    for (const policy of grant.policies) {
      const cost =
        policy.max_units_per_operation * policy.max_unit_price_microusd;
      if (
        !Number.isSafeInteger(cost) ||
        cost > grant.max_reserved_microusd ||
        policy.max_active_operations > grant.max_concurrent_operations
      )
        context.addIssue({
          code: "custom",
          message: "Policy reservation or concurrency exceeds the grant.",
        });
    }
  });

export type AuthorizationGrant = z.infer<typeof AuthorizationGrantSchema>;
export type EndpointPolicy = z.infer<typeof EndpointPolicySchema>;

export const PricingQuoteSchema = z
  .object({
    policy_id: slug,
    currency: z.literal("USD"),
    unit: slug,
    unit_price_microusd: integer,
    checked_at: instant,
    expires_at: instant,
    evidence_url: providerReference,
  })
  .strict();
export type PricingQuote = z.infer<typeof PricingQuoteSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function parseGrant(value: unknown): AuthorizationGrant {
  const parsed = AuthorizationGrantSchema.safeParse(value);
  if (!parsed.success)
    throw new ControlError(
      "INVALID_GRANT",
      "The authorization grant does not match the required contract.",
    );
  return parsed.data;
}
export function grantFingerprint(grant: AuthorizationGrant): string {
  return createHash("sha256").update(canonical(grant)).digest("hex");
}
