import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  grantFingerprint,
  parseGrant,
  type AuthorizationGrant,
} from "./contracts.js";
import { ControlError } from "./errors.js";
import type { Ledger } from "./pool.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PolicyMigrationAuditSchema = z
  .object({
    id: z.uuid(),
    recorded_at: z.string().datetime({ offset: true }),
    previous_grant_sha256: hash,
    next_grant_sha256: hash,
    policy_id: z.literal("tinyset-small"),
    from_max_operations: z.literal(2),
    to_max_operations: z.literal(4),
    from_source_url: z.literal(
      "https://docs.tinyfish.ai/datasets-api/reference",
    ),
    to_source_url: z.literal("https://docs.tinyfish.ai/datasets/reference.md"),
    operations_preserved: z.number().int().nonnegative(),
    reserved_microusd_preserved: z.number().int().nonnegative(),
    entries_sha256_preserved: hash,
  })
  .strict();
export type PolicyMigrationAudit = z.infer<typeof PolicyMigrationAuditSchema>;
const Pending = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    grant_file: z.string(),
    transaction_directory: z.string(),
  })
  .strict();
const Manifest = Pending.extend({
  files: z
    .array(
      z
        .object({
          name: z.enum(["grant", "binding", "ledger"]),
          old_sha256: hash,
          new_sha256: hash,
        })
        .strict(),
    )
    .length(3),
}).strict();
export type PolicyMigrationPlan = z.infer<typeof Manifest>;
export const MIGRATION_MARKER = ".policy-migration-pending.json";
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const failure = () =>
  new ControlError(
    "STATE_FAILURE",
    "The explicit policy migration requires review; no grant or allowance reset was attempted.",
  );
async function privateBytes(path: string, maximum = 4000000): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) throw failure();
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.size > maximum ||
    (await realpath(path)) !== path
  )
    throw failure();
  return readFile(path);
}
async function syncDirectory(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function writeNew(path: string, bytes: Buffer) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function replace(path: string, bytes: Buffer) {
  const temp = join(dirname(path), `.policy-migration-${randomUUID()}.tmp`);
  await writeNew(temp, bytes);
  await rename(temp, path);
  await syncDirectory(dirname(path));
}
const bytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
type Host = {
  grant: AuthorizationGrant;
  ledgerPath: string;
  bindingPath: string;
  clock: () => number;
  parseLedger: (input: unknown) => Ledger;
  validate: (grant: AuthorizationGrant, ledger: Ledger) => void;
};

export function nextTinySetGrant(old: AuthorizationGrant): AuthorizationGrant {
  const policy = old.policies.find((p) => p.id === "tinyset-small");
  if (
    !policy ||
    policy.unit !== "row" ||
    policy.max_units_per_operation !== 10 ||
    policy.max_unit_price_microusd !== 100000 ||
    policy.max_operations !== 2 ||
    policy.enforcement.mechanism !== "fixed_request_contract" ||
    policy.enforcement.source_url !==
      "https://docs.tinyfish.ai/datasets-api/reference"
  )
    throw failure();
  const next = parseGrant({
    ...old,
    policies: old.policies.map((p) =>
      p.id === policy.id
        ? {
            ...p,
            max_operations: 4,
            enforcement: {
              ...p.enforcement,
              source_url: "https://docs.tinyfish.ai/datasets/reference.md",
            },
          }
        : p,
    ),
  });
  const product = next.policies.reduce(
    (sum, p) =>
      sum +
      p.max_operations * p.max_units_per_operation * p.max_unit_price_microusd,
    0,
  );
  if (!Number.isSafeInteger(product) || product > old.max_reserved_microusd)
    throw failure();
  return next;
}

/** Called under PoolLedger's exclusive lock. Preparation suspends all normal readers/reservers. */
export async function prepareTinySetMigration(
  host: Host,
  ledger: Ledger,
  grantFile: string,
  confirmGrantId: string,
): Promise<PolicyMigrationPlan> {
  if (
    confirmGrantId !== host.grant.grant_id ||
    ledger.halted ||
    ledger.entries.some((e) => e.status !== "terminal") ||
    ledger.policy_migration
  )
    throw failure();
  const oldGrantBytes = await privateBytes(grantFile, 20000),
    diskGrant = parseGrant(JSON.parse(oldGrantBytes.toString()));
  if (grantFingerprint(diskGrant) !== grantFingerprint(host.grant))
    throw failure();
  const oldBindingBytes = await privateBytes(host.bindingPath, 2000),
    oldLedgerBytes = await privateBytes(host.ledgerPath);
  if (
    stableJson(host.parseLedger(JSON.parse(oldLedgerBytes.toString()))) !==
    stableJson(ledger)
  )
    throw failure();
  const nextGrant = nextTinySetGrant(host.grant),
    id = randomUUID();
  const audit: PolicyMigrationAudit = {
    id,
    recorded_at: new Date(host.clock()).toISOString(),
    previous_grant_sha256: grantFingerprint(host.grant),
    next_grant_sha256: grantFingerprint(nextGrant),
    policy_id: "tinyset-small",
    from_max_operations: 2,
    to_max_operations: 4,
    from_source_url: "https://docs.tinyfish.ai/datasets-api/reference",
    to_source_url: "https://docs.tinyfish.ai/datasets/reference.md",
    operations_preserved: ledger.entries.length,
    reserved_microusd_preserved: ledger.reserved_microusd,
    entries_sha256_preserved: sha256(stableJson(ledger.entries)),
  };
  const nextLedger: Ledger = {
    ...ledger,
    grant_sha256: grantFingerprint(nextGrant),
    policy_migration: audit,
  };
  host.validate(nextGrant, nextLedger);
  const nextBinding = {
    version: 1,
    pool_id: nextGrant.pool_id,
    grant_id: nextGrant.grant_id,
    grant_sha256: grantFingerprint(nextGrant),
  };
  const transactionDirectory = join(
    host.grant.state_directory,
    `policy-migration-${id}`,
  );
  await mkdir(transactionDirectory, { mode: 0o700 });
  const snapshots = {
    grant: { old: oldGrantBytes, next: bytes(nextGrant) },
    binding: { old: oldBindingBytes, next: bytes(nextBinding) },
    ledger: { old: oldLedgerBytes, next: bytes(nextLedger) },
  };
  const files = [];
  for (const name of ["grant", "binding", "ledger"] as const) {
    const pair = snapshots[name];
    await writeNew(join(transactionDirectory, `old-${name}.json`), pair.old);
    await writeNew(join(transactionDirectory, `new-${name}.json`), pair.next);
    files.push({
      name,
      old_sha256: sha256(pair.old),
      new_sha256: sha256(pair.next),
    });
  }
  const plan: PolicyMigrationPlan = {
    version: 1,
    id,
    grant_file: grantFile,
    transaction_directory: transactionDirectory,
    files,
  };
  await writeNew(join(transactionDirectory, "transaction.json"), bytes(plan));
  await syncDirectory(transactionDirectory);
  await writeNew(
    join(host.grant.state_directory, MIGRATION_MARKER),
    bytes({
      version: 1,
      id,
      grant_file: grantFile,
      transaction_directory: transactionDirectory,
    }),
  );
  await syncDirectory(host.grant.state_directory);
  return plan;
}

/** Explicitly resumes the SAME prepared transaction; each target must still be its exact old/new bytes. */
export async function commitTinySetMigration(
  host: Host,
  grantFile: string,
  confirmGrantId: string,
  confirmMigrationId: string,
): Promise<PolicyMigrationAudit> {
  const markerPath = join(host.grant.state_directory, MIGRATION_MARKER),
    pending = Pending.parse(
      JSON.parse((await privateBytes(markerPath, 2000)).toString()),
    );
  if (
    pending.id !== confirmMigrationId ||
    confirmGrantId !== host.grant.grant_id ||
    pending.grant_file !== grantFile ||
    pending.transaction_directory !==
      join(host.grant.state_directory, `policy-migration-${pending.id}`)
  )
    throw failure();
  const directoryStat = await lstat(pending.transaction_directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.mode & 0o077 ||
    (await realpath(pending.transaction_directory)) !==
      pending.transaction_directory
  )
    throw failure();
  const plan = Manifest.parse(
    JSON.parse(
      (
        await privateBytes(
          join(pending.transaction_directory, "transaction.json"),
          10000,
        )
      ).toString(),
    ),
  );
  if (
    stableJson({ ...plan, files: undefined }) !==
      stableJson({ ...pending, files: undefined }) ||
    new Set(plan.files.map((f) => f.name)).size !== 3
  )
    throw failure();
  const snapshots = new Map<string, { old: Buffer; next: Buffer }>();
  for (const file of plan.files) {
    const old = await privateBytes(
        join(pending.transaction_directory, `old-${file.name}.json`),
      ),
      next = await privateBytes(
        join(pending.transaction_directory, `new-${file.name}.json`),
      );
    if (sha256(old) !== file.old_sha256 || sha256(next) !== file.new_sha256)
      throw failure();
    snapshots.set(file.name, { old, next });
  }
  const oldGrant = parseGrant(
      JSON.parse(snapshots.get("grant")!.old.toString()),
    ),
    newGrant = parseGrant(JSON.parse(snapshots.get("grant")!.next.toString()));
  if (
    stableJson(nextTinySetGrant(oldGrant)) !== stableJson(newGrant) ||
    oldGrant.grant_id !== confirmGrantId ||
    oldGrant.pool_id !== host.grant.pool_id ||
    oldGrant.state_directory !== host.grant.state_directory ||
    ![grantFingerprint(oldGrant), grantFingerprint(newGrant)].includes(
      grantFingerprint(host.grant),
    )
  )
    throw failure();
  const oldLedger = host.parseLedger(
      JSON.parse(snapshots.get("ledger")!.old.toString()),
    ),
    newLedger = host.parseLedger(
      JSON.parse(snapshots.get("ledger")!.next.toString()),
    );
  host.validate(oldGrant, oldLedger);
  host.validate(newGrant, newLedger);
  const audit = newLedger.policy_migration;
  if (
    !audit ||
    audit.id !== pending.id ||
    oldLedger.halted ||
    oldLedger.entries.some((e) => e.status !== "terminal") ||
    oldLedger.policy_migration ||
    stableJson({
      ...newLedger,
      grant_sha256: oldLedger.grant_sha256,
      policy_migration: undefined,
    }) !== stableJson({ ...oldLedger, policy_migration: undefined })
  )
    throw failure();
  for (const [name, grant] of [
    ["old", oldGrant],
    ["new", newGrant],
  ] as const) {
    const binding = JSON.parse(
      (name === "old"
        ? snapshots.get("binding")!.old
        : snapshots.get("binding")!.next
      ).toString(),
    );
    if (
      stableJson(binding) !==
      stableJson({
        version: 1,
        pool_id: grant.pool_id,
        grant_id: grant.grant_id,
        grant_sha256: grantFingerprint(grant),
      })
    )
      throw failure();
  }
  const targets = {
    ledger: host.ledgerPath,
    binding: host.bindingPath,
    grant: grantFile,
  };
  for (const name of ["ledger", "binding", "grant"] as const) {
    const current = await privateBytes(targets[name]),
      pair = snapshots.get(name)!;
    if (
      sha256(current) !== sha256(pair.old) &&
      sha256(current) !== sha256(pair.next)
    )
      throw failure();
  }
  // All targets are preflighted before the first replacement. Pending marker and exclusive lock fence readers.
  for (const name of ["ledger", "binding", "grant"] as const) {
    await replace(targets[name], snapshots.get(name)!.next);
  }
  for (const name of ["ledger", "binding", "grant"] as const)
    if (
      sha256(await privateBytes(targets[name])) !==
      sha256(snapshots.get(name)!.next)
    )
      throw failure();
  const receiptPath = join(pending.transaction_directory, "committed.json");
  try {
    await writeNew(
      receiptPath,
      bytes({
        migration_id: pending.id,
        committed_at: new Date(host.clock()).toISOString(),
        audit,
      }),
    );
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
    const receipt = JSON.parse(
      (await privateBytes(receiptPath, 20000)).toString(),
    );
    if (
      receipt.migration_id !== pending.id ||
      stableJson(receipt.audit) !== stableJson(audit)
    )
      throw failure();
  }
  await syncDirectory(pending.transaction_directory);
  await unlink(markerPath);
  await syncDirectory(host.grant.state_directory);
  return audit;
}
