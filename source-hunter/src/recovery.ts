import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ProviderError } from "../../providers/pricing.js";
import type { ResearchReceipt } from "../../providers/research.js";
import { Selection, type SelectionInput } from "./core.js";
import { normalizeSelection } from "./recorded.js";

const Id = z.uuid();
const Count = z.number().int().nonnegative().safe();
const PoolId = z.string().regex(/^[a-z][a-z0-9._-]{2,63}$/u);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const InvestigationInput = z
  .object({
    version: z.literal(1),
    investigation_id: Id,
    selection: Selection,
    pool_id: PoolId,
    grant_id: Id,
    fetch_operations_before: Count,
  })
  .strict();
export const ResumeMetadata = z
  .object({
    version: z.literal(1),
    investigation_id: Id,
    provider_run_id: Id,
    research_reservation_id: Id,
    pool_id: PoolId,
    grant_id: Id,
    fetch_operations_before: Count,
    failure_code: z.literal("PRICING_UNAVAILABLE"),
    created_at: z.iso.datetime(),
    input_sha256: Hash,
    accepted_sha256: Hash,
    research_receipt_sha256: Hash,
  })
  .strict();
const CapturedReceipt = z
  .object({
    provider: z.literal("tinyfish-research"),
    mode: z.literal("deep"),
    research_run_id: Id,
    reservation_id: Id,
    reserved_microusd: Count,
    status: z.literal("COMPLETED"),
    recorded_at: z.iso.datetime(),
    result: z.string().trim().min(1).max(1500000),
    citations: z.array(z.string().max(4000)).max(1000),
    termination_reason: z.string().max(100).nullable(),
    warnings: z.array(z.string().max(8000)).max(10),
  })
  .strict();
const Accepted = z
  .object({
    research_run_id: Id,
    reservation: z.object({ id: Id }).passthrough(),
  })
  .passthrough();
const PoolStatus = z
  .object({
    pool_id: PoolId,
    grant_id: Id,
    halted: z.boolean(),
    active_operations: Count,
    by_policy: z.record(
      z.string(),
      z.object({ operations: Count }).passthrough(),
    ),
  })
  .passthrough();
export type RecoveryPoolStatus = z.input<typeof PoolStatus>;
const failure = () =>
  new ProviderError(
    "RESUME_UNAVAILABLE",
    "This investigation cannot be safely resumed. No provider operation was started.",
  );
const digest = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

export function fetchPricingTier(
  env: NodeJS.ProcessEnv = process.env,
): "hobby" | "builder" | undefined {
  const tier = env.TINYFISH_FETCH_PRICING_TIER;
  if (tier === undefined) return undefined;
  if (tier !== "hobby" && tier !== "builder")
    throw new ProviderError(
      "INVALID_INPUT",
      "TINYFISH_FETCH_PRICING_TIER must be explicitly hobby or builder.",
    );
  return tier;
}
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw failure();
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw failure();
  }
  throw failure();
}
/** No symlinks, shared permissions, hardlinks, oversized files or unbounded reads. */
async function privateBytes(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maximum ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw failure();
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        maximum + 1 - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw failure();
    return buffer.toString("utf8", 0, size);
  } finally {
    await file.close();
  }
}
/** Durable exclusive creation. Never overwrites an accepted receipt or a consumed marker. */
export async function writeInvestigationFile(
  directory: string,
  name: string,
  value: unknown,
) {
  if (!/^[a-z][a-z0-9-]*\.json$/u.test(name)) throw failure();
  await privateDirectory(directory);
  const file = await open(
    join(directory, name),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function createInvestigation(
  base: string,
  investigationId: string,
  selection: SelectionInput,
  rawStatus: RecoveryPoolStatus,
) {
  const id = Id.parse(investigationId),
    status = PoolStatus.parse(rawStatus);
  if (
    status.halted ||
    status.active_operations !== 0 ||
    !status.by_policy["fetch-public"]
  )
    throw failure();
  const input = InvestigationInput.parse({
    version: 1,
    investigation_id: id,
    selection,
    pool_id: status.pool_id,
    grant_id: status.grant_id,
    fetch_operations_before: status.by_policy["fetch-public"]!.operations,
  });
  const root = resolve(base),
    directory = join(root, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await privateDirectory(root);
  await mkdir(directory, { mode: 0o700 });
  await writeInvestigationFile(directory, "input.json", input);
  return { directory, input };
}
async function captured(base: string, rawId: string) {
  const id = Id.parse(rawId),
    root = resolve(base),
    directory = join(root, id);
  await privateDirectory(root);
  await privateDirectory(directory);
  const inputBytes = await privateBytes(join(directory, "input.json"), 12000);
  const acceptedBytes = await privateBytes(
    join(directory, "accepted.json"),
    100000,
  );
  const receiptBytes = await privateBytes(
    join(directory, "research-receipt.json"),
    8000000,
  );
  const input = InvestigationInput.parse(JSON.parse(inputBytes));
  const accepted = Accepted.parse(JSON.parse(acceptedBytes));
  const receipt = CapturedReceipt.parse(JSON.parse(receiptBytes));
  if (
    input.investigation_id !== id ||
    accepted.research_run_id !== receipt.research_run_id ||
    accepted.reservation.id !== receipt.reservation_id
  )
    throw failure();
  return {
    directory,
    input,
    receipt: receipt as ResearchReceipt,
    input_sha256: digest(inputBytes),
    accepted_sha256: digest(acceptedBytes),
    research_receipt_sha256: digest(receiptBytes),
  };
}
function unchanged(
  input: z.infer<typeof InvestigationInput>,
  rawStatus: RecoveryPoolStatus,
) {
  const status = PoolStatus.parse(rawStatus);
  if (
    status.halted ||
    status.active_operations !== 0 ||
    status.pool_id !== input.pool_id ||
    status.grant_id !== input.grant_id ||
    status.by_policy["fetch-public"]?.operations !==
      input.fetch_operations_before
  )
    throw failure();
}

/** Only an observed pricing preflight failure with zero new Fetch reservations is recoverable. */
export async function recordResumeAvailability(
  base: string,
  id: string,
  rawStatus: RecoveryPoolStatus,
  code: unknown,
) {
  if (code !== "PRICING_UNAVAILABLE") return false;
  try {
    const saved = await captured(base, id);
    unchanged(saved.input, rawStatus);
    await absent(join(saved.directory, "resume-consumed.json"));
    await absent(join(saved.directory, "chain.json"));
    const metadata = ResumeMetadata.parse({
      version: 1,
      investigation_id: saved.input.investigation_id,
      provider_run_id: saved.receipt.research_run_id,
      research_reservation_id: saved.receipt.reservation_id,
      pool_id: saved.input.pool_id,
      grant_id: saved.input.grant_id,
      fetch_operations_before: saved.input.fetch_operations_before,
      failure_code: code,
      created_at: new Date().toISOString(),
      input_sha256: saved.input_sha256,
      accepted_sha256: saved.accepted_sha256,
      research_receipt_sha256: saved.research_receipt_sha256,
    });
    await writeInvestigationFile(saved.directory, "resume.json", metadata);
    return true;
  } catch {
    return false;
  }
}

/** Validates and consumes one manual continuation; it has no Research-start capability. */
export async function consumeResume(
  base: string,
  rawId: string,
  rawSelection: SelectionInput,
  rawStatus: RecoveryPoolStatus,
) {
  try {
    const saved = await captured(base, rawId),
      selection = Selection.parse(rawSelection);
    const metadata = ResumeMetadata.parse(
      JSON.parse(
        await privateBytes(join(saved.directory, "resume.json"), 12000),
      ),
    );
    unchanged(saved.input, rawStatus);
    if (
      selection.page_url !== saved.input.selection.page_url ||
      normalizeSelection(selection.text) !==
        normalizeSelection(saved.input.selection.text) ||
      metadata.investigation_id !== saved.input.investigation_id ||
      metadata.pool_id !== saved.input.pool_id ||
      metadata.grant_id !== saved.input.grant_id ||
      metadata.fetch_operations_before !==
        saved.input.fetch_operations_before ||
      metadata.provider_run_id !== saved.receipt.research_run_id ||
      metadata.research_reservation_id !== saved.receipt.reservation_id ||
      metadata.input_sha256 !== saved.input_sha256 ||
      metadata.accepted_sha256 !== saved.accepted_sha256 ||
      metadata.research_receipt_sha256 !== saved.research_receipt_sha256
    )
      throw failure();
    await absent(join(saved.directory, "chain.json"));
    await writeInvestigationFile(saved.directory, "resume-consumed.json", {
      version: 1,
      investigation_id: saved.input.investigation_id,
      provider_run_id: saved.receipt.research_run_id,
      consumed_at: new Date().toISOString(),
    });
    return {
      directory: saved.directory,
      input: saved.input,
      receipt: saved.receipt,
    };
  } catch {
    throw failure();
  }
}
