# Source Hunter judge guide

Source Hunter helps a reader inspect a statistic before repeating it. The local workbench and Chrome popup distinguish a wording match from a proven citation edge, a producer-authored report from an explanatory page, and either of those from the earliest original source.

This guide follows the authenticated Source Hunter brief rechecked on 10 November 2026. The [TinyBounties board](https://www.tinybounties.com/crm?view=board) may require account access. Source and recorded evidence are in the [public GitHub repository](https://github.com/himanshu748/source-hunter). Anonymous clean-clone setup passed. The bounty was claimed on 10 November 2026 and has not been submitted. Authenticated form review passed; the owner's final prize-entry click and portal readback remain open. Automatic dispatch is held during the active owner handoff.

Source and recorded evidence are public in the [public GitHub repository](https://github.com/himanshu748/source-hunter). The [anonymous-clone verification](../evidence/checks/public-clone-verification.json) passed at commit `c294c2a1d2461be188feb9c4ee25073a992bb0b3` on Node.js 22.14 without provider credentials or grants: clean install, 99 tests, typecheck, build, review reproduction, formatting and recorded-only HTTP checks passed. No provider requests were started. The application runs locally; this is not a hosted deployment.

## Five-minute saved-evidence review

Use Node.js 22 or newer. Clone the public repository and start recorded mode:

```sh
git clone https://github.com/himanshu748/source-hunter.git
cd source-hunter
npm ci
BOUNTY_POOL_LIVE=0 npm start
```

Open [the local workbench](http://127.0.0.1:4388/). No key or provider allowance is needed for this path.

1. Open **Explore a recorded claim** and select the WHO food-security case. Inspect the checked release, report landing and unretrieved DOI target. Compare the rounded estimate with the independently located official report evidence. Do not read that comparison as another observed citation hop.
2. Select the Cloudflare Q1 2024 case. Its selected page is the producer-authored network report. Inspect the scope and publication date. The proposed Radar page returned an application error; missing words in that error do not establish a quotation mismatch.
3. Select the WHO air-quality case. Read the qualifying clause and separate publication/update context from measurement-period evidence. The reviewed URL alias is specific to the observed WHO pages.
4. Select the NASA Earth-year case. Keep its calendar approximation separate from sidereal and tropical year definitions. The separately located fact sheet is not inserted into an unobserved attribution chain.
5. Select the historical Great Wall case. The assessment concerns a historical quotation that the selected article examines skeptically. NASA refutes the unaided Moon-visibility assertion; that does not identify who first originated it.
6. Export an investigation as JSON. Check that it retains the selection, original run/time, assessment scope, source checks, dates, local-review metadata and unresolved provenance.

The five selections came from one real TinyResearch run, not five new jobs. This walkthrough replays saved results and starts no new research.

## Installed-extension review

The Chrome setup is documented in [the README](../README.md#use-the-chrome-extension). Load `source-hunter/extension/` unpacked, copy its displayed ID and start the local server with `SOURCE_HUNTER_EXTENSION_ID` and `BOUNTY_POOL_LIVE=0`.

For a matching-source test, use the `selection.page_url` and exact `selection.text` from [reviewed-batch.json](../evidence/reviewed-batch.json). Highlight that text on the actual public page, open the toolbar popup and choose **Show matching saved investigation**. Check capture, lookup, evidence display and export. Also try a different selection: it must return no match without a provider request.

On 9 November, the earlier installed Chrome bundle in a separate signed-out **Source Hunter Test** profile captured real public-page highlights for all five saved cases, returned the correct investigations and rendered dates and assessments. WHO full JSON export passed. An unmatched real Great Wall article title returned an explicit no match, with no substituted investigation and zero provider operations. The 420 px popup with its 20 px heading was readable. The [native screenshot](../evidence/native/chrome-final-who-popup.png) shows the earlier WHO pass; the [dated receipt](../evidence/verification-2026-11-09.json) records the earlier five saved checks.

The local workbench also passed all five saved selections and complete Great Wall JSON export in the in-app browser. Dialog Enter/Escape and a manual reduced-motion check passed. A requested 390 px mobile viewport remained 1,280 px, so mobile sizing is not verified. OS reduced-motion preference emulation is also unverified. The five saved cases, Great Wall workbench export, keyboard dialog, manual reduced motion and paused recovery controls were rerun successfully after unlock against the current bundle.

## Unseen NOAA test and manual recovery

The installed Chrome extension captured a previously unseen NOAA selection about 2024 being the warmest year on record. One Deep run, `01a1c024-d22d-7ea0-bdf2-7d99467c669a`, completed. `PRICING_UNAVAILABLE` then blocked Fetch before any Fetch request or reservation. After account-tier and free-quota confirmation, one **Resume source checks** click reused the completed receipt for nine source checks, with zero new Research jobs and no automatic retry. Full native export matched the private packet. [Fresh receipt](../evidence/fresh/fresh-verification.json).

The original nine-check packet preserves matched selected wording, an unresolved assessment and unestablished primary/earliest status. Its [export](../evidence/fresh/noaa-original-export.json) is unchanged; the separate [cached re-evaluation](../evidence/fresh/noaa-local-re-evaluation.json) made zero new network requests. Later, one explicitly authorized manual PDF repeat used the tenth remaining Fetch check under the same $2 supplement and no new Research. With selectors omitted, the official PDF was captured. A separate local review reached the NOAA/NASA producer briefing supporting the 2024-warmest finding. Its supported publication precision is January 2025, month only. Dataset validation, exact publication day, earliest authorship and the observed portal-to-PDF link remain unproved. [Manual check](../evidence/fresh/manual-pdf-check.json), [local review](../evidence/fresh/manual-pdf-review.json). CSV extraction remains mock-tested only.

The final NOAA recovery popup passed. The current bundle subsequently passed all five saved Chrome and workbench cases. Native and HTTP checks confirmed fresh tracing was paused, and recovery remained disabled for a valid investigation ID.

## Requirement-to-evidence map

| Bounty requirement or approval criterion                                            | Inspect                                                                                            | Current boundary                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome or Firefox extension: highlight text to start a trace                        | [Manifest](../extension/manifest.json), popup and local API                                        | The earlier Chrome bundle passed all five real highlights and saved lookups, plus WHO full export and an unmatched-selection check. The actual NOAA fresh test passed; all five saved cases passed again after recovery controls; no Firefox result is claimed. |
| Follow citations across live pages to the earliest source available                 | [Reviewed batch](../evidence/reviewed-batch.json), [source review](../evidence/source-review.json) | Observed edges and independently found comparisons are separate. No complete earliest-origin trail is claimed.                                                                                                                                                  |
| Each source has a link, date and exact wording; compare the claim with the original | Source cards, assessments, date records and short excerpts                                         | Checked wording and dates retain their method and precision. Unretrieved targets and contextual evidence stay labelled.                                                                                                                                         |
| Flag changed, rounded, misquoted or untraceable claims                              | Reviewed assessment and gap fields                                                                 | The food estimate has a supported rounding explanation and the historical Moon quotation is contradicted. All five saved Chrome cases passed. No verified changed or misquoted case is invented; the edited video preserves those distinctions.                 |
| Demonstrate at least five real claims, including one wrong claim                    | Five saved selections and the reviewed historical-quotation assessment                             | Genuine batch evidence and all five saved Chrome journeys exist. The edited, captioned 124-second walkthrough shows all five saved cases and the wrong historical assertion; metadata, full decode and visual checks passed.                                    |
| TinyResearch performs an essential role                                             | Original batch, run identity and query/parser code                                                 | One genuine Deep run investigated all five selections; nine Fetch checks supplied exact-page observations. Later local source review is separate.                                                                                                               |
| Reach a primary source where one exists                                             | Per-case `primary_source_status` and source evidence                                               | The SOFI publication is identified, Cloudflare's producer report is reached and the later manual NOAA PDF review reached a producer briefing. Underlying dataset validation and earliest authorship remain separate open findings.                              |
| Work across different sites and topics; remain quick and clear                      | Generic input/live path, five recorded topics, workbench and popup                                 | All five native saved cases and all five workbench selections passed. Dialog keyboard and manual reduced-motion checks passed. Current saved-case regression passed. Mobile sizing and OS motion-preference emulation remain unverified.                        |

## Checks and remaining delivery gates

99 tests, TypeScript, build, review reproduction and formatting passed on Node.js 26.12. Saved-review reproduction and mocked provider tests establish their named boundaries, not another live investigation. The dated receipt retains earlier checkpoints separately.

Fetch pricing is now checked before paid Research or recovery-marker consumption, then before every Fetch. Explicit `TINYFISH_FETCH_PRICING_TIER=hobby` requires confirmation of the same account's current tier and quota. There is no cheapest-meter selection or Builder fallback. Recovery is one-shot, limited to the zero-Fetch pricing failure, with selection, grant/pool and hash checks. The selection snapshot was migrated once from the actual capture because it predated recovery support; acceptance and Research receipt bytes stayed unchanged and the migration is recorded.

The old $10 ledger remains unchanged and halted. A separate $2 supplement is fully reserved, bringing the aggregate authorized ceiling across the bounty work to $12. Reservations are not a verified invoice. No further provider job, retry, purchase or billing change is authorized.

The [124-second silent walkthrough](../evidence/media/source-hunter-demo.mp4) combines edited saved-case captures and the actual NOAA recovery. H.264, 1080p/60 fps metadata, full decoding and sampled-frame visual checks passed. Separate current-browser receipts establish the regression pass. The video does not prove primary authorship or publication. [Media receipt](../evidence/media/video-verification.json).

Technical package and current-browser checks passed. LinkedIn, Discord and X promotions were published under explicit authorization and read back on 10 November. The bounty is claimed but not submitted. Current eligibility, authenticated form fields, final links and selected media have been checked. The final form is prepared for the owner. The owner retains the final prize-entry click. The checked cutoff is 17 November 2026 at 23:59 Pacific time, equivalent to 18 November at 13:29 India time.

## Promotion and entry status

[LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7525837908667404288/), [Discord showcase](https://discord.com/channels/1200506685236711554/1569631090870853713) and [X](https://x.com/jhahimanshu653/status/2120073889749635288) were published and read back on 10 November 2026. LinkedIn includes the actual TinyFish company mention and the 124-second video; X tags `@Tiny_Fish` and includes the video; Discord has a dedicated Source Hunter showcase thread and video. Discord may require server access. [Public-safe confirmation](../evidence/release/promotion-confirmation.json).

The bounty is **CLAIMED, NOT SUBMITTED**. Authenticated form review passed with the required URLs, 1,711 note characters and the selected video. The owner's final prize-entry click and portal readback remain open. The global rulebook calls X optional, while the current form marks both LinkedIn and X URLs required; the actual posts satisfy that stricter form. The current form limits notes to 2,000 characters and media to 25 MB. The form is held for the owner; a selected attachment or published post is not portal submission confirmation.

Authenticated form check on 10 November: [prepared fields and attachment](../evidence/release/final-form-ui-check.json). The final prize-entry click was not performed by the agent.
