# Source Hunter privacy and operational boundaries

Source Hunter is a local, single-user research tool. Use public source pages and non-sensitive selections. An HTTPS URL alone does not establish that its content is public.

## What the extension reads and sends

Opening the toolbar popup uses `activeTab` and `scripting` to read the current selection, page title and URL. It does not install a persistent page listener or capture other tabs, cookies or browsing history. The captured selection is displayed before either investigation action. The full page URL remains visible so the reader can inspect it.

**Show matching saved investigation** sends those three fields to `http://127.0.0.1:4388/api/source-hunter/recorded-match`. The server checks the exact public URL and selected text after NFKC and whitespace normalization. Only explicitly reviewed source aliases are accepted. A missing match does not substitute another claim or start research. This action reads the saved artifact; it makes no TinyFish request or fresh source-page retrieval.

**Trace this statistic** is a separate fresh action. When live work is explicitly enabled and its controls permit it, the local server sends the selection, title and URL to one TinyResearch Deep job. It does not send the rest of the current browser page or the browser's signed-in session. After persisting the completed Research receipt, the server may request at most ten distinct exact source URLs through TinyFetch, without page-check retries. These may include cited comparison and date sources as well as proposed attribution pages. Provider retention and processing are outside this local package's controls.

The [manifest](../extension/manifest.json) requests only `activeTab`, `scripting` and fixed localhost port 4388 access. It has no cookie, browsing-history, persistent-storage or broad website host permission and no remote script. An unpacked extension still grants code access under those permissions. All five saved Chrome cases passed again with the current recovery controls. The actual NOAA recovery popup and full native export also passed, with the same narrow permissions. [Evidence boundaries](EVIDENCE.md#verification-and-remaining-gates).

## Local server controls

The server binds to `127.0.0.1`. Mutating API requests require the exact local Host and either its own UI Origin or the configured `chrome-extension://` ID. CORS is not a wildcard. Requests have a bounded JSON body, validated selections and a single active live-run guard.

URL validation rejects literal IP addresses, local/reserved hostnames, credentials, non-HTTPS sources and secret-like query parameters. These checks do not prove that a page is public, resolve every hostname's eventual target, or establish that a quoted claim is true. Retrieved page content is untrusted data; result rendering uses text-only DOM nodes and public-link checks rather than inserting source HTML.

The non-billable `/health` endpoint reports local mode, extension configuration and validated recorded-artifact availability. It reads no key or grant and does not claim provider health, credit availability or permission for a paid run.

## Credentials, spending and receipts

Saved mode is the default and needs no credential file. Use `BOUNTY_POOL_LIVE=0 npm start` for the review path.

Fresh work requires `BOUNTY_POOL_LIVE=1`, an explicit absolute `BOUNTY_POOL_GRANT_FILE` and `TINYFISH_KEY_FILE`, and the grant's existing durable ledger. Private configuration files must be regular, owner-only files; the credential identity must match the authorized grant. Do not put a usable key or private grant into this package, browser code, exported evidence or public logs.

The previous $10 shared ledger remains unchanged and halted. A separate $2 supplement is fully reserved for the actual NOAA test, now one Research run and ten Fetch checks, all terminal. The aggregate authorized ceiling across the bounty work remains $12. Reservations are not a verified invoice. No further provider job, retry, purchase, ledger reset or billing change is authorized. A mode flag or health response cannot expand that authority.

`TINYFISH_FETCH_PRICING_TIER=hobby` is an explicit operator binding used only after confirming the same account's current Hobby tier and daily free-quota headroom. Fetch pricing is checked before paid Research or recovery-marker consumption, then again before each Fetch. Missing, ambiguous or nonzero prices fail closed. There is no cheapest-meter selection or Builder fallback. Known PDF/CSV paths omit HTML selectors. The PDF path passed on one separately authorized manual tenth check; CSV extraction remains mock-tested only.

**Resume source checks** is limited to a completed Research receipt whose source stage stopped with `PRICING_UNAVAILABLE` before any Fetch reservation. It validates the same selection and grant/pool, hash-pinned private files and a one-shot consumed marker. It starts no Research job and cannot retry an attempted source. The NOAA recovery ran once and reused its completed run for nine checks.

The initial selection snapshot predated recovery support and was migrated once from the actual native capture. That migration is recorded; acceptance and Research receipt bytes stayed unchanged. This exception is not permission to rewrite historical evidence.

Fresh server receipts are written under `.private/source-hunter/` by default, with owner-only directory/file permissions. `BOUNTY_RESEARCH_OUTPUT_DIRECTORY` may point to an explicit external private directory. Accepted run identity is saved before waiting for completion; the completed Research receipt is persisted before any Fetch checks, and page captures and receipts are also retained privately. Closing the popup does not cancel an accepted provider job; the server can continue and retains its receipt. The app has no automatic deletion or expiry of those local files.

## Exports and publication

Saved JSON exports retain the original run/time, the selected source, scoped assessments, short excerpts, dates, check states, local-review method and limitations. They are recorded evidence, not a fresh verification of the web. Original provider receipts and full source captures are kept outside the public package.

Fresh JSON exports retain provenance, page receipts, failures and separate Research/Fetch counters. The [original nine-check Chrome export](../evidence/fresh/noaa-original-export.json) stays unchanged, including its unresolved assessment and failed PDF capture. Its JSON values matched the private packet; native-download and private-packet byte hashes have separate serialization scopes. The [cached re-evaluation](../evidence/fresh/noaa-local-re-evaluation.json) made zero new network requests and did not retrieve that PDF. Later, one explicitly authorized manual repeat used the tenth remaining Fetch check under the same $2 allowance, without another Research job. The [manual capture](../evidence/fresh/manual-pdf-check.json) and [local review](../evidence/fresh/manual-pdf-review.json) remain separate from the original packet. They reached a producer briefing, while exact publication day, dataset validation, earliest authorship and the observed portal-to-PDF edge remain unproved.

Review exports and captures before sharing. A selection or account screenshot can be sensitive without matching a scanner pattern. Account identity, balance, tier screenshots and credentials remain private. The validated 124-second silent walkthrough uses edited product captures from saved cases and the actual NOAA recovery. It is an edited walkthrough. Separate receipts establish the current browser regression; no publication is implied. Show the final video and copy to the owner before posting.

After the test, HTTP confirmed recorded-only mode. The native popup subsequently confirmed paused tracing and recovery disabled for a valid investigation ID. No Source Hunter public repository, hosted service, post, bounty claim, submission or approval is established. No source license has been selected. The owner retains the final prize-entry click.
