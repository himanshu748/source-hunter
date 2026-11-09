import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadControlsFromEnvironment } from "../../shared/index.js";
import type { ResearchReceipt } from "../../providers/research.js";
import { Selection } from "./core.js";
import { corroborateChain } from "./audit.js";
const [inputPath, receiptPath, outputPath] = process.argv.slice(2);
try {
  if (!inputPath || !receiptPath || !outputPath) throw new Error("usage");
  const selection = Selection.parse(
    JSON.parse(await readFile(inputPath, "utf8")) as unknown,
  );
  const receipt = JSON.parse(
    await readFile(receiptPath, "utf8"),
  ) as ResearchReceipt;
  const report = await corroborateChain(
    selection,
    receipt,
    await loadControlsFromEnvironment(),
  );
  const output = resolve(outputPath);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    join(output, "corroborated-chain.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      verification: report.verification,
      status: report.status,
      hops: report.hops.map((h) => ({
        url: h.url,
        quote_check: h.quote_check,
        link_to_next: h.link_to_next,
      })),
    }),
  );
} catch {
  console.error(
    "Source corroboration did not complete. No paid Research run was started.",
  );
  process.exitCode = 1;
}
