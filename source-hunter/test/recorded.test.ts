import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RecordedBatch,
  matchingRecordedTrace,
  readRecordedBatch,
} from "../src/recorded.js";

const raw = JSON.parse(
  await readFile(
    new URL("../evidence/live-batch.json", import.meta.url),
    "utf8",
  ),
);

test("saved lookup requires the exact claim and source, allowing only harmless text normalization and fragments", () => {
  const batch = RecordedBatch.parse(raw),
    trace = batch.traces[0]!;
  assert.equal(
    matchingRecordedTrace(batch, {
      ...trace.selection,
      text: trace.selection.text
        .replace("2.33", "２.３３")
        .replaceAll(" ", "\n  "),
      page_url: trace.selection.page_url + "#same-page",
    })?.id,
    trace.id,
  );
  for (const selection of [
    { ...trace.selection, text: trace.selection.text.replace("2.33", "2.34") },
    { ...trace.selection, page_url: "https://example.org/another-page" },
    { ...trace.selection, page_url: trace.selection.page_url + "/" },
    { ...trace.selection, page_url: trace.selection.page_url + "?different=1" },
  ])
    assert.equal(matchingRecordedTrace(batch, selection), undefined);
  assert.throws(() =>
    matchingRecordedTrace(batch, {
      ...trace.selection,
      page_url: "https://127.0.0.1/",
    }),
  );
});

test("source aliases must be explicit and cannot make two saved claims ambiguous", () => {
  const data = structuredClone(raw);
  const alias = "https://www.who.int/source-alias-for-offline-test";
  data.traces[0].selection_url_aliases = [alias];
  const batch = RecordedBatch.parse(data);
  assert.equal(
    matchingRecordedTrace(batch, {
      ...batch.traces[0]!.selection,
      page_url: alias,
    })?.id,
    batch.traces[0]!.id,
  );
  const duplicate = structuredClone(data.traces[0]);
  duplicate.id = "different-id-same-identity";
  data.traces = [data.traces[0], duplicate];
  assert.throws(() => RecordedBatch.parse(data));
});

test("recorded artifacts preserve run identity, cannot borrow another claim's evidence, and strip undeclared raw fields", () => {
  const wrongRun = structuredClone(raw);
  wrongRun.traces[0].chain.provider_run_id =
    "00000000-0000-4000-8000-000000000001";
  assert.throws(() => RecordedBatch.parse(wrongRun));
  const wrongQuote = structuredClone(raw);
  wrongQuote.traces[0].assessment.evidence[0].quote_ref =
    raw.traces[1].id + ".chain.hops.0.quote";
  assert.throws(() => RecordedBatch.parse(wrongQuote));
  const extra = structuredClone(raw);
  extra.raw_provider_receipt = "not-for-http";
  extra.traces[0].private_capture = "not-for-http";
  const parsed = RecordedBatch.parse(extra);
  assert.ok(!("raw_provider_receipt" in parsed));
  assert.ok(!("private_capture" in parsed.traces[0]!));
});

test("a malformed reviewed artifact fails closed rather than serving an older investigation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-recorded-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "live-batch.json"), JSON.stringify(raw));
  const url = pathToFileURL(directory + "/");
  assert.equal((await readRecordedBatch(url)).traces.length, 5);
  await writeFile(join(directory, "reviewed-batch.json"), '{"traces":[]}');
  await assert.rejects(readRecordedBatch(url));
});
