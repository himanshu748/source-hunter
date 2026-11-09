import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { PoolLedger, PrivateApiKey } from "../../shared/index.js";
import { fetchHtml } from "../../providers/fetch.js";
import { publicUrl } from "../../providers/public-url.js";
import type { ResearchReceipt } from "../../providers/research.js";
import { sourceResult, type SelectionInput } from "./core.js";
const normalize = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, " ").trim();
/** Quotes and outgoing links are checked against fresh exact-URL provider HTML. */
export async function corroborateChain(
  selection: SelectionInput,
  receipt: ResearchReceipt,
  controls: { pool: PoolLedger; key: PrivateApiKey },
  signal?: AbortSignal,
) {
  const chain = sourceResult(selection, receipt),
    hops = [];
  let interrupted = false;
  for (let i = 0; i < chain.hops.length; i++) {
    const hop = chain.hops[i]!,
      next = chain.hops[i + 1];
    const base = {
      ...hop,
      quote_check: "not_checked" as
        "not_checked" | "matched" | "not_found" | "fetch_failed",
      link_to_next: "not_checked" as
        "not_checked" | "matched" | "not_found" | "not_applicable",
      checked_at: null as string | null,
      html_sha256: null as string | null,
      fetch_reservation_id: null as string | null,
    };
    if (interrupted) {
      hops.push(base);
      continue;
    }
    try {
      const result = await fetchHtml({
        ...controls,
        bountyId: "source-hunter",
        policyId: "fetch-public",
        url: hop.url,
        selectors: ["body"],
        assertAllowed: (url) => {
          if (publicUrl(url) !== hop.url) throw new Error("SOURCE_NOT_ALLOWED");
        },
        signal,
      });
      const $ = load(result.html);
      $("script,style,noscript").remove();
      const quote = normalize(hop.quote),
        text = normalize($.text());
      base.quote_check =
        quote && text.includes(quote) ? "matched" : "not_found";
      base.link_to_next = next ? "not_found" : "not_applicable";
      if (next)
        for (const anchor of $("a[href]").toArray()) {
          try {
            if (
              publicUrl(new URL($(anchor).attr("href")!, hop.url).href) ===
              next.url
            ) {
              base.link_to_next = "matched";
              break;
            }
          } catch {
            /* Non-public links are not evidence. */
          }
        }
      base.checked_at = result.observed_at;
      base.html_sha256 = createHash("sha256").update(result.html).digest("hex");
      base.fetch_reservation_id = result.reservation_id;
    } catch {
      base.quote_check = "fetch_failed";
      const status = await controls.pool.status();
      if (status.halted || signal?.aborted) interrupted = true;
    }
    hops.push(base);
  }
  const matched =
    hops.length >= 1 &&
    hops.every(
      (h) =>
        h.quote_check === "matched" &&
        (h.link_to_next === "matched" || h.link_to_next === "not_applicable"),
    );
  return {
    ...chain,
    hops,
    verification: matched
      ? "quotes_and_links_corroborated"
      : "research_candidate",
    limitations: [
      ...chain.limitations,
      ...(!matched
        ? [
            "One or more exact-page quotes or outgoing links could not be corroborated.",
          ]
        : []),
      "Primary-source authorship and the statistical definition still require review; matching text and links alone do not establish that the figure is methodologically sound.",
    ],
  };
}
