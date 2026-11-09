import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadControlsFromEnvironment } from "../../shared/index.js";
import { runDeepResearch } from "../../providers/research.js";
import { Selection, sourceQuery, sourceResult } from "./core.js";

const [command, inputPath, outputPath] = process.argv.slice(2);
if (command !== "trace" || !inputPath || !outputPath) {
  console.error(
    "Usage: npx tsx source-hunter/src/cli.ts trace INPUT.json OUTPUT_DIRECTORY\nLive only: requires the already initialized shared private grant. No automatic retry.",
  );
  process.exitCode = 1;
} else {
  try {
    const selection = Selection.parse(
        JSON.parse(await readFile(inputPath, "utf8")) as unknown,
      ),
      output = resolve(outputPath);
    await mkdir(output, { recursive: true, mode: 0o700 });
    await chmod(output, 0o700);
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const receipt = await runDeepResearch({
      controls: await loadControlsFromEnvironment(),
      bounty: "source-hunter",
      query: sourceQuery(selection),
      signal: controller.signal,
      onStarted: async (started) => {
        await writeFile(
          join(output, "accepted.json"),
          JSON.stringify(started, null, 2),
          { mode: 0o600, flag: "wx" },
        );
        console.log(
          JSON.stringify({
            status: "accepted",
            research_run_id: started.research_run_id,
          }),
        );
      },
      onProgress: (status) => console.log(JSON.stringify({ status })),
    });
    const result = sourceResult(selection, receipt);
    await writeFile(
      join(output, "research-receipt.json"),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      join(output, "chain.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      JSON.stringify({ status: result.status, output_directory: output }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        code:
          typeof error === "object" && error && "code" in error
            ? error.code
            : "INVALID_OR_FAILED_REQUEST",
        message:
          "Trace did not complete. Inspect the private ledger and saved acceptance before any retry.",
      }),
    );
    process.exitCode = 1;
  }
}
