import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  grantFingerprint,
  parseGrant,
  PricingQuoteSchema,
  type AuthorizationGrant,
  type EndpointPolicy,
  type PricingQuote,
} from "./contracts.js";
import { assertNotCancelled, ControlError } from "./errors.js";
import {
  PolicyMigrationAuditSchema,
  MIGRATION_MARKER,
  prepareTinySetMigration,
  commitTinySetMigration,
  stableJson,
  sha256,
  type PolicyMigrationPlan,
  type PolicyMigrationAudit,
} from "./migration.js";

const count = z.number().int().nonnegative().max(1_000_000_000_000);
const time = z.string().datetime({ offset: true });
const FetchReconciliationSchema = z
  .object({
    grant_id: z.uuid(),
    reservation_id: z.uuid(),
    request_id: z.uuid(),
    policy_id: z.string(),
    http_status_class: z.literal("2xx"),
    http_status: z.number().int().min(200).max(299).nullable(),
    error_code: z.literal("RESPONSE_TOO_LARGE"),
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    reconciled_at: time,
    action: z.literal("fixed_fetch_terminal_failure"),
    reserved_microusd_retained: count,
  })
  .strict();
const FetchProofSchema = FetchReconciliationSchema.omit({
  reconciled_at: true,
  action: true,
  reserved_microusd_retained: true,
});
export type FixedFetchTerminalProof = z.infer<typeof FetchProofSchema>;
const EntrySchema = z
  .object({
    id: z.uuid(),
    request_id: z.uuid(),
    bounty_id: z.string(),
    policy_id: z.string(),
    reserved_microusd: count,
    created_at: time,
    status: z.enum(["reserved", "started", "terminal", "uncertain"]),
    provider_reference: z.string().nullable(),
    finished_at: time.nullable(),
    outcome: z
      .enum(["success", "failure", "cancelled", "cancelled_before_dispatch"])
      .nullable(),
    accounted_units: count.nullable(),
  })
  .strict();
const LedgerSchema = z
  .object({
    version: z.literal(1),
    pool_id: z.string(),
    grant_id: z.uuid(),
    grant_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: time,
    max_reserved_microusd: count,
    reserved_microusd: count,
    halted: z.boolean(),
    halt_reason: z
      .enum(["remote_termination_unknown", "accounting_unexpected"])
      .nullable(),
    entries: z.array(EntrySchema).max(10_000),
    reconciliations: z.array(FetchReconciliationSchema).max(10_000).optional(),
    policy_migration: PolicyMigrationAuditSchema.optional(),
  })
  .strict();
const BindingSchema = z
  .object({
    version: z.literal(1),
    pool_id: z.string(),
    grant_id: z.uuid(),
    grant_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Ledger = z.infer<typeof LedgerSchema>;
type Entry = z.infer<typeof EntrySchema>;
export type Reservation = Readonly<
  Pick<
    Entry,
    | "id"
    | "request_id"
    | "bounty_id"
    | "policy_id"
    | "reserved_microusd"
    | "created_at"
  >
>;
export type Clock = () => number;

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
function safeReference(value: string, keyFingerprint: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    !/^(?:sk[-_]|gh[pousr]_|github_pat_|https?:|wss?:|bearer)/i.test(value) &&
    createHash("sha256").update(value).digest("hex") !== keyFingerprint
  );
}

/** One private ledger for the entire new-bounty grant. This class makes no network requests. */
export class PoolLedger {
  readonly #grant: AuthorizationGrant;
  readonly #path: string;
  readonly #bindingPath: string;
  readonly #lock: string;
  constructor(
    grant: unknown,
    private readonly clock: Clock = Date.now,
  ) {
    this.#grant = parseGrant(grant);
    this.#path = join(this.#grant.state_directory, "ledger.json");
    this.#bindingPath = join(this.#grant.state_directory, "grant-binding.json");
    this.#lock = join(this.#grant.state_directory, ".ledger.lock");
  }
  /** Authoritative immutable request bounds for a transport using this exact pool instance. */
  getPolicy(policyId: string): Readonly<EndpointPolicy> {
    this.assertActiveGrant();
    const policy = this.#grant.policies.find(
      (candidate) => candidate.id === policyId,
    );
    if (!policy)
      throw new ControlError(
        "INVALID_REQUEST",
        "The endpoint has no approved policy.",
      );
    const copy = structuredClone(policy);
    Object.freeze(copy.enforcement);
    return Object.freeze(copy);
  }
  /** Compatibility name for callers that emphasize dispatch bounds. */
  policyBounds(policyId: string): Readonly<EndpointPolicy> {
    return this.getPolicy(policyId);
  }
  private assertActiveGrant(): void {
    const now = this.clock();
    if (
      Date.parse(this.#grant.authorized_at) > now + 5000 ||
      Date.parse(this.#grant.expires_at) <= now
    )
      throw new ControlError(
        "AUTHORIZATION_REQUIRED",
        "The grant is not currently active.",
      );
  }
  private async assertDirectory(): Promise<void> {
    try {
      const stat = await lstat(this.#grant.state_directory);
      if (
        !stat.isDirectory() ||
        (stat.mode & 0o077) !== 0 ||
        (await realpath(this.#grant.state_directory)) !==
          this.#grant.state_directory
      )
        throw new Error("unsafe directory");
    } catch {
      throw new ControlError(
        "STATE_FAILURE",
        "The canonical private state directory is unavailable or unsafe.",
      );
    }
  }
  private async write(ledger: Ledger): Promise<void> {
    const temporary = join(
      this.#grant.state_directory,
      ".ledger-" + randomUUID() + ".tmp",
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(ledger, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
      const directory = await open(this.#grant.state_directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new ControlError(
        "STATE_FAILURE",
        "The durable ledger write could not be confirmed. No provider request should be sent.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  private async createBinding(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#bindingPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          pool_id: this.#grant.pool_id,
          grant_id: this.#grant.grant_id,
          grant_sha256: grantFingerprint(this.#grant),
        }) + "\n",
        "utf8",
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      const directory = await open(this.#grant.state_directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new ControlError(
        "STATE_FAILURE",
        "The one-time grant binding could not be created durably. Do not initialize a replacement allowance.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  private async verifyBinding(): Promise<void> {
    try {
      try {
        await lstat(join(this.#grant.state_directory, MIGRATION_MARKER));
        throw new Error("pending policy migration");
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
      const stat = await lstat(this.#bindingPath);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2000)
        throw new Error("unsafe binding");
      const binding = BindingSchema.parse(
        JSON.parse(await readFile(this.#bindingPath, "utf8")),
      );
      if (
        binding.pool_id !== this.#grant.pool_id ||
        binding.grant_id !== this.#grant.grant_id ||
        binding.grant_sha256 !== grantFingerprint(this.#grant)
      )
        throw new Error("binding mismatch");
    } catch {
      throw new ControlError(
        "STATE_FAILURE",
        "The existing pool binding is unavailable or disagrees with the grant. No reset was attempted.",
      );
    }
  }
  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertDirectory();
    try {
      await mkdir(this.#lock, { mode: 0o700 });
    } catch (error) {
      throw new ControlError(
        code(error) === "EEXIST" ? "BUSY" : "STATE_FAILURE",
        code(error) === "EEXIST"
          ? "The pool ledger is locked. Stale locks are never removed automatically."
          : "The pool ledger could not be locked.",
      );
    }
    try {
      return await operation();
    } finally {
      try {
        await rmdir(this.#lock);
      } catch {
        throw new ControlError(
          "STATE_FAILURE",
          "The ledger lock could not be released; reconcile before further work.",
        );
      }
    }
  }
  private validateLedger(ledger: Ledger): void {
    const grant = this.#grant;
    if (
      ledger.pool_id !== grant.pool_id ||
      ledger.grant_id !== grant.grant_id ||
      ledger.grant_sha256 !== grantFingerprint(grant) ||
      ledger.max_reserved_microusd !== grant.max_reserved_microusd ||
      new Set(ledger.entries.map((e) => e.id)).size !== ledger.entries.length ||
      new Set(ledger.entries.map((e) => e.request_id)).size !==
        ledger.entries.length
    )
      throw new ControlError(
        "STATE_FAILURE",
        "Ledger identity or grant binding disagrees; no reset was attempted.",
      );
    const total = ledger.entries.reduce(
      (sum, entry) => sum + entry.reserved_microusd,
      0,
    );
    if (
      !Number.isSafeInteger(total) ||
      total !== ledger.reserved_microusd ||
      total > grant.max_reserved_microusd ||
      ledger.halted !== (ledger.halt_reason !== null)
    )
      throw new ControlError(
        "STATE_FAILURE",
        "Ledger totals or halt state disagree; no repair was guessed.",
      );
    for (const entry of ledger.entries) {
      const policy = grant.policies.find((p) => p.id === entry.policy_id);
      if (
        !policy ||
        !grant.allowed_bounties.includes(entry.bounty_id) ||
        entry.reserved_microusd !==
          policy.max_units_per_operation * policy.max_unit_price_microusd ||
        (entry.provider_reference !== null &&
          !safeReference(entry.provider_reference, grant.key_sha256)) ||
        (entry.status === "terminal") !==
          (entry.finished_at !== null && entry.outcome !== null) ||
        (entry.status !== "terminal" &&
          (entry.finished_at !== null || entry.outcome !== null)) ||
        (entry.status === "started" && entry.provider_reference === null) ||
        (entry.status === "uncertain" && !ledger.halted) ||
        (entry.accounted_units !== null &&
          entry.accounted_units > policy.max_units_per_operation &&
          !ledger.halted)
      )
        throw new ControlError(
          "STATE_FAILURE",
          "A ledger entry violates its authorized contract.",
        );
    }
    const reconciled = new Set<string>();
    for (const audit of ledger.reconciliations ?? []) {
      const entry = ledger.entries.find((e) => e.id === audit.reservation_id);
      const policy = grant.policies.find((p) => p.id === audit.policy_id);
      if (
        reconciled.has(audit.reservation_id) ||
        !entry ||
        !policy ||
        audit.grant_id !== grant.grant_id ||
        entry.request_id !== audit.request_id ||
        entry.policy_id !== audit.policy_id ||
        entry.status !== "terminal" ||
        entry.outcome !== "failure" ||
        entry.accounted_units !== 1 ||
        entry.finished_at !== audit.reconciled_at ||
        entry.reserved_microusd !== audit.reserved_microusd_retained ||
        !this.fixedFetchPolicy(policy)
      )
        throw new ControlError(
          "STATE_FAILURE",
          "A fixed Fetch reconciliation disagrees with its retained reservation.",
        );
      reconciled.add(audit.reservation_id);
    }
    const active = ledger.entries.filter((e) => e.status !== "terminal");
    if (ledger.policy_migration) {
      const audit = ledger.policy_migration,
        policy = grant.policies.find((p) => p.id === audit.policy_id),
        prefix = ledger.entries.slice(0, audit.operations_preserved);
      if (
        audit.next_grant_sha256 !== ledger.grant_sha256 ||
        audit.previous_grant_sha256 === audit.next_grant_sha256 ||
        !policy ||
        policy.max_operations !== 4 ||
        policy.enforcement.source_url !== audit.to_source_url ||
        audit.operations_preserved > ledger.entries.length ||
        sha256(stableJson(prefix)) !== audit.entries_sha256_preserved ||
        prefix.reduce((sum, e) => sum + e.reserved_microusd, 0) !==
          audit.reserved_microusd_preserved
      )
        throw new ControlError(
          "STATE_FAILURE",
          "The policy migration no longer preserves its original entries and allowance.",
        );
    }
    if (active.length > grant.max_concurrent_operations)
      throw new ControlError(
        "STATE_FAILURE",
        "Ledger concurrency exceeds the grant.",
      );
    for (const policy of grant.policies) {
      const entries = ledger.entries.filter((e) => e.policy_id === policy.id);
      if (
        entries.length > policy.max_operations ||
        entries.filter((e) => e.status !== "terminal").length >
          policy.max_active_operations
      )
        throw new ControlError(
          "STATE_FAILURE",
          "An endpoint counter exceeds its authorized limit.",
        );
    }
  }
  private async read(): Promise<Ledger> {
    try {
      await this.verifyBinding();
      const stat = await lstat(this.#path);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4_000_000)
        throw new Error("unsafe ledger");
      const ledger = LedgerSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
      this.validateLedger(ledger);
      return ledger;
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError(
        "STATE_FAILURE",
        "The existing private ledger cannot be trusted. It was not created or reset.",
      );
    }
  }
  private async mutate<T>(change: (ledger: Ledger) => T): Promise<T> {
    return this.lock(async () => {
      const ledger = await this.read();
      const result = change(ledger);
      this.validateLedger(ledger);
      await this.write(ledger);
      return result;
    });
  }
  /** Deliberate operator-only initialization. Normal reserve/status never initialize missing state. */
  async initialize(): Promise<void> {
    this.assertActiveGrant();
    await mkdir(this.#grant.state_directory, {
      recursive: true,
      mode: 0o700,
    }).catch(() => {
      throw new ControlError(
        "STATE_FAILURE",
        "The private state directory could not be prepared.",
      );
    });
    await this.lock(async () => {
      try {
        await lstat(this.#bindingPath);
        throw new ControlError(
          "STATE_FAILURE",
          "This grant already has a pool binding. Missing ledger state must be reconciled, never initialized again.",
        );
      } catch (error) {
        if (error instanceof ControlError) throw error;
        if (code(error) !== "ENOENT")
          throw new ControlError(
            "STATE_FAILURE",
            "The existing pool binding could not be inspected.",
          );
      }
      try {
        await lstat(this.#path);
      } catch (error) {
        if (code(error) !== "ENOENT")
          throw new ControlError(
            "STATE_FAILURE",
            "Existing state could not be inspected.",
          );
        await this.createBinding();
        await this.write({
          version: 1,
          pool_id: this.#grant.pool_id,
          grant_id: this.#grant.grant_id,
          grant_sha256: grantFingerprint(this.#grant),
          created_at: new Date(this.clock()).toISOString(),
          max_reserved_microusd: this.#grant.max_reserved_microusd,
          reserved_microusd: 0,
          halted: false,
          halt_reason: null,
          entries: [],
        });
        return;
      }
      throw new ControlError(
        "STATE_FAILURE",
        "A ledger already exists. Initialization never resets it.",
      );
    });
  }
  private quote(policy: EndpointPolicy, input: unknown): PricingQuote {
    const parsed = PricingQuoteSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.policy_id !== policy.id ||
      parsed.data.unit !== policy.unit
    )
      throw new ControlError(
        "INVALID_REQUEST",
        "Pricing metadata does not match the selected endpoint policy.",
      );
    const quote = parsed.data,
      now = this.clock(),
      checked = Date.parse(quote.checked_at),
      expires = Date.parse(quote.expires_at);
    if (
      checked < now - 60000 ||
      checked > now + 5000 ||
      expires <= now ||
      expires <= checked ||
      expires > checked + 300000
    )
      throw new ControlError(
        "PRICING_STALE",
        "Pricing metadata is stale, future-dated or exceeds its validity bound.",
      );
    if (quote.unit_price_microusd > policy.max_unit_price_microusd)
      throw new ControlError(
        "PRICING_CHANGED",
        "Observed unit pricing exceeds the authorized maximum.",
      );
    return quote;
  }
  async reserve(
    input: {
      request_id: string;
      bounty_id: string;
      policy_id: string;
      pricing: unknown;
    },
    signal?: AbortSignal,
  ): Promise<Reservation> {
    assertNotCancelled(signal);
    this.assertActiveGrant();
    if (
      !z.uuid().safeParse(input.request_id).success ||
      !this.#grant.allowed_bounties.includes(input.bounty_id)
    )
      throw new ControlError(
        "INVALID_REQUEST",
        "Use a new request UUID and an authorized bounty identity.",
      );
    const policy = this.#grant.policies.find((p) => p.id === input.policy_id);
    if (!policy)
      throw new ControlError(
        "INVALID_REQUEST",
        "The endpoint has no approved policy.",
      );
    this.quote(policy, input.pricing);
    return this.mutate((ledger) => {
      assertNotCancelled(signal);
      this.assertActiveGrant();
      this.quote(policy, input.pricing);
      if (ledger.halted)
        throw new ControlError(
          "HALTED",
          "The shared pool requires accounting or termination review.",
        );
      if (ledger.entries.some((e) => e.request_id === input.request_id))
        throw new ControlError(
          "DUPLICATE_OPERATION",
          "This request UUID was already reserved. No paid retry was authorized.",
        );
      const active = ledger.entries.filter((e) => e.status !== "terminal");
      if (
        active.length >= this.#grant.max_concurrent_operations ||
        active.filter((e) => e.policy_id === policy.id).length >=
          policy.max_active_operations
      )
        throw new ControlError(
          "BUSY",
          "The shared pool or endpoint concurrency bound is occupied.",
        );
      const cost =
        policy.max_units_per_operation * policy.max_unit_price_microusd;
      if (
        ledger.entries.filter((e) => e.policy_id === policy.id).length >=
          policy.max_operations ||
        ledger.reserved_microusd + cost > this.#grant.max_reserved_microusd
      )
        throw new ControlError(
          "ALLOWANCE_EXHAUSTED",
          "The aggregate pool or endpoint count allowance is exhausted.",
        );
      const entry: Entry = {
        id: randomUUID(),
        request_id: input.request_id,
        bounty_id: input.bounty_id,
        policy_id: policy.id,
        reserved_microusd: cost,
        created_at: new Date(this.clock()).toISOString(),
        status: "reserved",
        provider_reference: null,
        finished_at: null,
        outcome: null,
        accounted_units: null,
      };
      ledger.reserved_microusd += cost;
      ledger.entries.push(entry);
      return Object.freeze({
        id: entry.id,
        request_id: entry.request_id,
        bounty_id: entry.bounty_id,
        policy_id: entry.policy_id,
        reserved_microusd: cost,
        created_at: entry.created_at,
      });
    });
  }
  async markStarted(id: string, providerReference: string): Promise<void> {
    if (!safeReference(providerReference, this.#grant.key_sha256))
      throw new ControlError(
        "INVALID_REQUEST",
        "Use a provider operation identifier, never credentials or connection URLs.",
      );
    await this.mutate((ledger) => {
      const entry = ledger.entries.find((e) => e.id === id);
      if (
        !entry ||
        !["reserved", "started"].includes(entry.status) ||
        ledger.entries.some(
          (other) =>
            other.id !== id && other.provider_reference === providerReference,
        ) ||
        (entry.provider_reference !== null &&
          entry.provider_reference !== providerReference)
      )
        throw new ControlError(
          "STATE_FAILURE",
          "The provider identifier cannot be applied to this reservation.",
        );
      entry.provider_reference = providerReference;
      entry.status = "started";
    });
  }
  async cancelBeforeDispatch(id: string): Promise<void> {
    await this.mutate((ledger) => {
      const entry = ledger.entries.find((e) => e.id === id);
      if (
        !entry ||
        entry.status !== "reserved" ||
        entry.provider_reference !== null
      )
        throw new ControlError(
          "STATE_FAILURE",
          "Only a request known not to have been dispatched can be cancelled this way.",
        );
      entry.status = "terminal";
      entry.outcome = "cancelled_before_dispatch";
      entry.accounted_units = 0;
      entry.finished_at = new Date(this.clock()).toISOString();
    });
  }
  async recordTerminal(
    id: string,
    outcome: "success" | "failure" | "cancelled",
    accountedUnits?: number,
  ): Promise<void> {
    if (
      !["success", "failure", "cancelled"].includes(outcome) ||
      (accountedUnits !== undefined && !count.safeParse(accountedUnits).success)
    )
      throw new ControlError(
        "INVALID_REQUEST",
        "Terminal accounting does not match the supported contract.",
      );
    await this.mutate((ledger) => {
      const entry = ledger.entries.find((e) => e.id === id);
      if (!entry || entry.status === "terminal")
        throw new ControlError(
          "STATE_FAILURE",
          "The reservation is missing or already terminal.",
        );
      const policy = this.#grant.policies.find(
        (p) => p.id === entry.policy_id,
      )!;
      entry.status = "terminal";
      entry.outcome = outcome;
      entry.accounted_units = accountedUnits ?? null;
      entry.finished_at = new Date(this.clock()).toISOString();
      if (
        accountedUnits === undefined ||
        accountedUnits > policy.max_units_per_operation
      ) {
        ledger.halted = true;
        ledger.halt_reason = "accounting_unexpected";
      }
    });
  }
  async recordUncertain(id: string): Promise<void> {
    await this.mutate((ledger) => {
      const entry = ledger.entries.find((e) => e.id === id);
      if (!entry || entry.status === "terminal")
        throw new ControlError(
          "STATE_FAILURE",
          "The reservation is missing or already terminal.",
        );
      entry.status = "uncertain";
      ledger.halted = true;
      ledger.halt_reason = "remote_termination_unknown";
    });
  }
  private fixedFetchPolicy(policy: EndpointPolicy): boolean {
    return (
      policy.unit === "url" &&
      policy.max_units_per_operation === 1 &&
      policy.enforcement.mechanism === "fixed_request_contract" &&
      [
        "https://docs.tinyfish.ai/fetch-api/reference",
        "https://docs.tinyfish.ai/fetch-api/reference.md",
      ].includes(policy.enforcement.source_url)
    );
  }
  /** Explicit reviewed recovery for one synchronous Fetch2xx oversized-body failure. Never retries or refunds. */
  async reconcileFixedFetchTerminalFailure(
    input: FixedFetchTerminalProof,
  ): Promise<void> {
    const parsed = FetchProofSchema.safeParse(input);
    if (!parsed.success || parsed.data.grant_id !== this.#grant.grant_id)
      throw new ControlError(
        "INVALID_REQUEST",
        "A matching grant, request and reviewed2xx fixed Fetch proof are required.",
      );
    const proof = parsed.data;
    await this.mutate((ledger) => {
      const entry = ledger.entries.find((e) => e.id === proof.reservation_id);
      const policy = this.#grant.policies.find((p) => p.id === proof.policy_id);
      if (
        !ledger.halted ||
        !entry ||
        entry.status !== "uncertain" ||
        entry.provider_reference !== null ||
        entry.request_id !== proof.request_id ||
        entry.policy_id !== proof.policy_id ||
        !policy ||
        !this.fixedFetchPolicy(policy)
      )
        throw new ControlError(
          "STATE_FAILURE",
          "Only the exact uncertain one-URL synchronous Fetch can be reconciled by this proof.",
        );
      const accountingHalt = ledger.halt_reason === "accounting_unexpected";
      const at = new Date(this.clock()).toISOString();
      entry.status = "terminal";
      entry.outcome = "failure";
      entry.accounted_units = 1;
      entry.finished_at = at;
      (ledger.reconciliations ??= []).push({
        ...proof,
        reconciled_at: at,
        action: "fixed_fetch_terminal_failure",
        reserved_microusd_retained: entry.reserved_microusd,
      });
      const badAccounting = ledger.entries.some(
        (e) =>
          e.status === "terminal" &&
          (e.accounted_units === null ||
            e.accounted_units >
              this.#grant.policies.find((p) => p.id === e.policy_id)!
                .max_units_per_operation),
      );
      const uncertain = ledger.entries.some((e) => e.status === "uncertain");
      ledger.halted = accountingHalt || badAccounting || uncertain;
      ledger.halt_reason =
        accountingHalt || badAccounting
          ? "accounting_unexpected"
          : uncertain
            ? "remote_termination_unknown"
            : null;
    });
  }
  async status() {
    return this.lock(async () => {
      const ledger = await this.read();
      return {
        pool_id: ledger.pool_id,
        grant_id: ledger.grant_id,
        currency: "USD" as const,
        max_reserved_microusd: ledger.max_reserved_microusd,
        reserved_microusd: ledger.reserved_microusd,
        remaining_microusd:
          ledger.max_reserved_microusd - ledger.reserved_microusd,
        active_operations: ledger.entries.filter((e) => e.status !== "terminal")
          .length,
        halted: ledger.halted,
        halt_reason: ledger.halt_reason,
        operations_used: ledger.entries.length,
        by_policy: Object.fromEntries(
          this.#grant.policies.map((policy) => [
            policy.id,
            {
              operations: ledger.entries.filter(
                (e) => e.policy_id === policy.id,
              ).length,
              max_operations: policy.max_operations,
              active_operations: ledger.entries.filter(
                (e) => e.policy_id === policy.id && e.status !== "terminal",
              ).length,
              max_active_operations: policy.max_active_operations,
              reserved_microusd: ledger.entries
                .filter((e) => e.policy_id === policy.id)
                .reduce((sum, e) => sum + e.reserved_microusd, 0),
            },
          ]),
        ),
        by_bounty: Object.fromEntries(
          this.#grant.allowed_bounties.map((bounty) => [
            bounty,
            {
              operations: ledger.entries.filter((e) => e.bounty_id === bounty)
                .length,
              reserved_microusd: ledger.entries
                .filter((e) => e.bounty_id === bounty)
                .reduce((sum, e) => sum + e.reserved_microusd, 0),
            },
          ]),
        ),
      };
    });
  }
  /** Explicit narrow preparation; all ordinary operations remain fenced until reviewed commit/resume. */
  async prepareTinySetPolicyCountMigration(
    grantFile: string,
    confirmGrantId: string,
  ): Promise<PolicyMigrationPlan> {
    this.assertActiveGrant();
    return this.lock(async () =>
      prepareTinySetMigration(
        {
          grant: this.#grant,
          ledgerPath: this.#path,
          bindingPath: this.#bindingPath,
          clock: this.clock,
          parseLedger: (input) => LedgerSchema.parse(input),
          validate: (grant, ledger) =>
            new PoolLedger(grant, this.clock).validateLedger(ledger),
        },
        await this.read(),
        grantFile,
        confirmGrantId,
      ),
    );
  }
  /** Idempotently resumes only the exact prepared transaction; never removes a stale process lock. */
  async commitTinySetPolicyCountMigration(
    grantFile: string,
    confirmGrantId: string,
    confirmMigrationId: string,
  ): Promise<PolicyMigrationAudit> {
    return this.lock(() =>
      commitTinySetMigration(
        {
          grant: this.#grant,
          ledgerPath: this.#path,
          bindingPath: this.#bindingPath,
          clock: this.clock,
          parseLedger: (input) => LedgerSchema.parse(input),
          validate: (grant, ledger) =>
            new PoolLedger(grant, this.clock).validateLedger(ledger),
        },
        grantFile,
        confirmGrantId,
        confirmMigrationId,
      ),
    );
  }
}
