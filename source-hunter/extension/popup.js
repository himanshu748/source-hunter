/* No page listener, persistent storage, cookie access, key, or remote script. */
const LOCAL_ORIGIN = "http://127.0.0.1:4388";
const investigationId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const el = (id) => document.getElementById(id);
const words = (value) =>
  typeof value === "string" ? value.replaceAll("_", " ") : "not established";
const normalizeSelection = (value) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim();
let selection = null;
let result = null;
let busy = false;
let connection = {
  state: "checking",
  live: false,
  configured: false,
  count: 0,
};

// A display/link boundary, not a DNS or source-verification claim.
function publicHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(
        host,
      ) ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(
        host,
      )
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
function sourceLink(rawUrl, title) {
  const url = publicHttpsUrl(rawUrl);
  if (!url) {
    const label = document.createElement("span");
    label.className = "withheld-link";
    label.textContent = `${title || "Source"} (unsafe link withheld)`;
    return label;
  }
  const link = document.createElement("a");
  link.href = url;
  link.textContent = title || new URL(url).hostname;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  return link;
}
function paragraph(text, className) {
  const node = document.createElement("p");
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function heading(text) {
  const node = document.createElement("h2");
  node.textContent = text;
  return node;
}
function metadataRow(label, value) {
  const dt = document.createElement("dt"),
    dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  return [dt, dd];
}
function checkedTime(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
      ? value
      : "Not established";
  }
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : "Not established";
}
function updateActions() {
  const available =
    selection &&
    !busy &&
    connection.state === "online" &&
    connection.configured &&
    connection.authorized !== false;
  el("recorded").disabled = !available || connection.count === 0;
  el("trace").disabled = !available || !connection.live;
  el("resume").disabled =
    !available ||
    !connection.live ||
    !investigationId.test(el("recovery-id").value.trim());
  el("recovery-id").disabled = busy;
  el("retry-connection").disabled = busy || connection.state === "checking";
  el("results").setAttribute("aria-busy", String(busy));
}
function setState(message, error = false) {
  el("state").textContent = message;
  el("state").classList.toggle("is-error", error);
}
function updateConnection() {
  el("connection").parentElement.dataset.state =
    connection.state === "online" &&
    (!connection.configured || connection.authorized === false)
      ? "needs-authorization"
      : connection.state;
  el("connection-setup").hidden =
    connection.state === "online" &&
    connection.configured &&
    connection.authorized !== false;
  if (connection.state === "checking") {
    el("connection").textContent = "Checking the local server…";
  } else if (connection.state !== "online") {
    el("connection").textContent =
      "Local server unavailable. Start Source Hunter on port 4388, then recheck.";
  } else if (!connection.configured || connection.authorized === false) {
    el("connection").textContent =
      "The local server needs to authorize this extension ID.";
  } else {
    el("connection").textContent = connection.count
      ? `Local server available · ${connection.count} saved investigations`
      : "Local server available · no saved investigations";
  }
  el("fresh-note").textContent =
    connection.state === "online" && connection.live
      ? "Fresh research is enabled. The server checks its allowance before starting."
      : "Fresh research is paused. Saved lookup starts no provider run.";
  updateActions();
}
async function checkConnection() {
  connection = { state: "checking", live: false, configured: false, count: 0 };
  updateConnection();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`${LOCAL_ORIGIN}/health`, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Unavailable");
    const health = await response.json();
    if (
      health.service !== "source-hunter" ||
      !["recorded_only", "live_enabled"].includes(health.mode) ||
      typeof health.extension_configured !== "boolean" ||
      !Number.isInteger(health.recorded_trace_count) ||
      health.recorded_trace_count < 0 ||
      health.recorded_trace_count > 5
    )
      throw new Error("Invalid readiness response");
    connection = {
      state: "online",
      live: health.mode === "live_enabled",
      configured: health.extension_configured,
      count: health.recorded_trace_count,
    };
  } catch {
    connection = { state: "offline", live: false, configured: false, count: 0 };
  } finally {
    clearTimeout(timer);
    updateConnection();
  }
}
async function captureSelection() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("No active page");
    const [capture] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        text: window.getSelection()?.toString().trim() ?? "",
        page_url: location.href,
        page_title: document.title,
      }),
    });
    const value = capture?.result;
    if (
      !value ||
      typeof value.text !== "string" ||
      value.text.length < 10 ||
      value.text.length > 1000 ||
      typeof value.page_title !== "string" ||
      value.page_title.length > 250 ||
      !publicHttpsUrl(value.page_url)
    ) {
      setState("Select 10–1,000 characters on a public HTTPS page.");
      return;
    }
    selection = value;
    el("selection").textContent = value.text;
    el("page").textContent = value.page_url;
    setState(
      "Selection captured. Choose a saved investigation or fresh research.",
    );
  } catch {
    setState("This page cannot be read. Try a normal public HTTPS page.", true);
  } finally {
    updateActions();
  }
}

// A reference may resolve only within this trace and on its stated source URL.
function referencedQuote(trace, packet, item) {
  const url = publicHttpsUrl(item.source_url);
  if (!url) return null;
  if (typeof item.quote === "string") return item.quote;
  const ref = item.quote_ref;
  if (typeof ref !== "string" || !ref.startsWith(`${trace.id}.`)) return null;
  const prefix = `${trace.id}.chain.hops.`;
  if (ref.startsWith(prefix) && ref.endsWith(".quote")) {
    const index = ref.slice(prefix.length, -".quote".length);
    if (/^\d+$/.test(index)) {
      const hop = trace.chain.hops[Number(index)];
      if (
        hop &&
        publicHttpsUrl(hop.url) === url &&
        typeof hop.quote === "string"
      )
        return hop.quote;
    }
  }
  const excerpt = (Array.isArray(packet.excerpts) ? packet.excerpts : []).find(
    (entry) => entry.ref === ref && publicHttpsUrl(entry.url) === url,
  );
  return typeof excerpt?.quote === "string" ? excerpt.quote : null;
}
function renderAssessment(trace, packet) {
  const assessment = trace.assessment;
  if (!assessment || typeof assessment.label !== "string") return [];
  const labels = {
    matches: "Selected wording matches",
    contradicted: "Selected claim contradicted",
    rounded: "Rounded figure",
    misquoted: "Misquoted selection",
    unresolved: "Assessment unresolved",
  };
  const title =
    assessment.target === "historical_quoted_claim" &&
    assessment.label === "contradicted"
      ? "Historical quotation contradicted"
      : labels[assessment.label] || words(assessment.label);
  const nodes = [heading(title)];
  if (trace.context) nodes.push(paragraph(trace.context, "assessment-context"));
  if (assessment.target)
    nodes.push(
      paragraph(`Assessed target: ${words(assessment.target)}.`, "muted"),
    );
  if (assessment.scope)
    nodes.push(paragraph(`Scope: ${words(assessment.scope)}.`, "muted"));
  if (assessment.reason) nodes.push(paragraph(assessment.reason));
  if (assessment.check)
    nodes.push(
      paragraph(`Evidence check: ${words(assessment.check)}.`, "muted"),
    );
  const evidence = Array.isArray(assessment.evidence)
    ? assessment.evidence
    : [];
  if (evidence.length) {
    const list = document.createElement("ul");
    list.className = "evidence-list";
    for (const item of evidence) {
      const li = document.createElement("li");
      li.append(
        sourceLink(item.source_url),
        paragraph(
          `${words(item.stance)} · excerpt ${words(item.quote_check)}`,
          "muted",
        ),
      );
      const quote = referencedQuote(trace, packet, item);
      if (quote) li.append(paragraph(quote, "source-quote"));
      else if (item.quote_ref)
        li.append(
          paragraph(
            "The cited excerpt is not available for this source in this export.",
            "muted",
          ),
        );
      list.append(li);
    }
    nodes.push(list);
  }
  if (assessment.research_explanation || assessment.proposed_label) {
    const details = document.createElement("details"),
      summary = document.createElement("summary");
    summary.textContent = "Original research proposal";
    details.append(summary);
    if (assessment.proposed_label)
      details.append(
        paragraph(`Proposed label: ${words(assessment.proposed_label)}.`),
      );
    if (assessment.research_explanation)
      details.append(paragraph(assessment.research_explanation));
    details.append(
      paragraph(
        "The provider narrative is not independent source proof.",
        "muted",
      ),
    );
    nodes.push(details);
  }
  return nodes;
}
function renderReview(review) {
  if (!review || typeof review !== "object") return [];
  const nodes = [heading("Local source review")];
  if (typeof review.summary === "string") nodes.push(paragraph(review.summary));
  const metadata = document.createElement("dl");
  metadata.className = "metadata";
  metadata.append(...metadataRow("Reviewed", checkedTime(review.checked_at)));
  if (review.method)
    metadata.append(...metadataRow("Method", words(review.method)));
  if (review.provider_requests_started === 0)
    metadata.append(...metadataRow("New provider requests", "0"));
  nodes.push(metadata);
  if (Array.isArray(review.limitations) && review.limitations.length) {
    const list = document.createElement("ul");
    for (const limitation of review.limitations) {
      const li = document.createElement("li");
      li.textContent = limitation;
      list.append(li);
    }
    nodes.push(list);
  }
  return nodes;
}
function renderDates(trace, packet) {
  if (!Array.isArray(trace.dates)) return [];
  return trace.dates.map((date) => {
    const li = document.createElement("li");
    const value =
      date.value == null || date.value === "unknown"
        ? "not established"
        : date.value;
    li.append(
      paragraph(`${words(date.kind)}: ${value}`, "date-value"),
      paragraph(
        `${words(date.precision)} precision · ${words(date.check)}`,
        "muted",
      ),
    );
    if (date.source_url) {
      li.append(sourceLink(date.source_url));
      const quote = referencedQuote(trace, packet, date);
      if (quote) li.append(paragraph(quote, "source-quote"));
    }
    return li;
  });
}
function renderHops(hops) {
  return hops.map((hop) => {
    const li = document.createElement("li"),
      label = document.createElement("div");
    label.className = "hop-label";
    label.textContent = `${words(hop.role)} · excerpt ${words(hop.quote_check)}`;
    li.append(label, sourceLink(hop.url, hop.title));
    if (hop.quote)
      li.append(
        paragraph(
          hop.quote + (hop.excerpt_shortened ? "…" : ""),
          "source-quote",
        ),
      );
    li.append(
      paragraph(`Page checked: ${checkedTime(hop.checked_at)}`, "muted"),
    );
    if (hop.link_to_next)
      li.append(
        paragraph(`Outgoing link: ${words(hop.link_to_next)}.`, "muted"),
      );
    if (hop.relationship_to_next)
      li.append(paragraph(hop.relationship_to_next, "relationship"));
    return li;
  });
}
function validatePacket(packet, saved) {
  const trace = packet?.trace;
  const chain = trace?.chain;
  const strings = (value, maximum) =>
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string");
  const object = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const selected = (value) =>
    object(value) &&
    typeof value.text === "string" &&
    typeof value.page_title === "string" &&
    publicHttpsUrl(value.page_url);
  const invalid = () => {
    throw new Error(
      "The server returned an invalid investigation. The previous result is unchanged.",
    );
  };
  if (
    !object(packet) ||
    packet.mode !== (saved ? "recorded_research" : "fresh_research") ||
    !object(trace) ||
    typeof trace.id !== "string" ||
    !trace.id ||
    !selected(trace.selection) ||
    typeof trace.context !== "string" ||
    typeof trace.selection_quote_check !== "string" ||
    typeof trace.earliest_source_status !== "string" ||
    (trace.primary_source_status !== undefined &&
      typeof trace.primary_source_status !== "string") ||
    (trace.selection_url_aliases !== undefined &&
      (!strings(trace.selection_url_aliases, 5) ||
        !trace.selection_url_aliases.every(publicHttpsUrl))) ||
    !chain ||
    !selected(chain.selection) ||
    normalizeSelection(chain.selection.text) !==
      normalizeSelection(trace.selection.text) ||
    publicHttpsUrl(chain.selection.page_url) !==
      publicHttpsUrl(trace.selection.page_url) ||
    typeof packet.provider_run_id !== "string" ||
    !packet.provider_run_id ||
    packet.provider_run_id !== chain.provider_run_id ||
    checkedTime(packet.recorded_at) === "Not established" ||
    !packet.recorded_at.includes("T") ||
    packet.recorded_at !== chain.recorded_at ||
    typeof chain.verification !== "string" ||
    typeof chain.summary !== "string" ||
    !["candidate", "unresolved"].includes(chain.status) ||
    !Array.isArray(chain.hops) ||
    chain.hops.length > 8 ||
    !chain.hops.every(
      (hop) =>
        object(hop) &&
        typeof hop.url === "string" &&
        typeof hop.title === "string" &&
        ["selected_page", "intermediary", "primary_candidate"].includes(
          hop.role,
        ) &&
        typeof hop.quote === "string" &&
        typeof hop.quote_check === "string" &&
        (hop.link_to_next === undefined ||
          typeof hop.link_to_next === "string") &&
        (hop.relationship_to_next == null ||
          typeof hop.relationship_to_next === "string") &&
        (hop.checked_at == null ||
          checkedTime(hop.checked_at) !== "Not established"),
    ) ||
    !strings(chain.limitations, 40) ||
    !object(trace.assessment) ||
    ![
      "matches",
      "rounded",
      "changed",
      "misquoted",
      "contradicted",
      "unresolved",
    ].includes(trace.assessment.label) ||
    !["target", "reason", "check"].every(
      (key) => typeof trace.assessment[key] === "string",
    ) ||
    !["scope", "proposed_label", "research_explanation"].every(
      (key) =>
        trace.assessment[key] === undefined ||
        typeof trace.assessment[key] === "string",
    ) ||
    !Array.isArray(trace.assessment.evidence) ||
    trace.assessment.evidence.length > 12 ||
    !trace.assessment.evidence.every(
      (item) =>
        object(item) &&
        typeof item.source_url === "string" &&
        typeof item.stance === "string" &&
        typeof item.quote_check === "string" &&
        (item.quote_ref == null || typeof item.quote_ref === "string"),
    ) ||
    !Array.isArray(trace.dates) ||
    trace.dates.length > 15 ||
    !trace.dates.every(
      (date) =>
        object(date) &&
        ["kind", "precision", "source_url", "check"].every(
          (key) => typeof date[key] === "string",
        ) &&
        (date.value == null || typeof date.value === "string") &&
        (date.quote_ref == null || typeof date.quote_ref === "string"),
    ) ||
    !Array.isArray(packet.excerpts) ||
    packet.excerpts.length > 100 ||
    !packet.excerpts.every(
      (excerpt) =>
        object(excerpt) &&
        ["ref", "url", "quote"].every(
          (key) => typeof excerpt[key] === "string",
        ),
    )
  )
    invalid();
  if (saved) {
    if (packet.provider_requests_started !== 0) invalid();
  } else if (
    packet.research_jobs_started !== 1 ||
    "provider_requests_started" in packet ||
    packet.local_review !== undefined ||
    trace.local_review !== undefined ||
    !Number.isInteger(packet.source_page_checks) ||
    packet.source_page_checks < 0 ||
    !Number.isInteger(packet.maximum_page_checks) ||
    packet.maximum_page_checks < 0 ||
    packet.maximum_page_checks > 10 ||
    packet.source_page_checks > packet.maximum_page_checks ||
    !Array.isArray(packet.page_receipts) ||
    packet.page_receipts.length > packet.source_page_checks ||
    !packet.page_receipts.every(
      (receipt) =>
        object(receipt) &&
        ["url", "final_url", "fetch_reservation_id"].every(
          (key) => typeof receipt[key] === "string",
        ) &&
        checkedTime(receipt.checked_at) !== "Not established" &&
        typeof receipt.html_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(receipt.html_sha256) &&
        ["usable", "unusable"].includes(receipt.document_status) &&
        (receipt.failure_code === null ||
          typeof receipt.failure_code === "string"),
    ) ||
    !Array.isArray(packet.page_failures) ||
    !packet.page_failures.every(
      (failure) =>
        object(failure) &&
        typeof failure.url === "string" &&
        typeof failure.code === "string",
    ) ||
    packet.page_checks !== packet.source_page_checks ||
    !object(packet.provenance) ||
    packet.provenance.method !==
      "single_research_with_bounded_exact_page_checks" ||
    packet.provenance.research_provider !== "tinyfish-research" ||
    packet.provenance.research_mode !== "deep" ||
    packet.provenance.research_status !== "COMPLETED" ||
    packet.provenance.selected_context_status !== "unassessed" ||
    packet.provenance.earliest_authorship !== "not_established" ||
    packet.provenance.primary_authorship !== "not_established" ||
    trace.earliest_source_status !== "unresolved" ||
    trace.primary_source_status !== "not_established" ||
    !strings(packet.limitations, 100)
  )
    invalid();
  const matchingUrls = [
    trace.selection.page_url,
    ...(trace.selection_url_aliases || []),
  ].map(publicHttpsUrl);
  if (
    !selection ||
    normalizeSelection(trace.selection.text) !==
      normalizeSelection(selection.text) ||
    !matchingUrls.includes(publicHttpsUrl(selection.page_url))
  )
    throw new Error(
      `The ${saved ? "saved" : "fresh"} investigation does not match this selection. The previous result is unchanged.`,
    );
  return trace;
}
function render(packet, saved) {
  const trace = validatePacket(packet, saved);
  const chain = trace.chain;
  const review = saved ? trace.local_review || packet.local_review : null;
  if (review) {
    if (
      typeof review !== "object" ||
      typeof review.summary !== "string" ||
      typeof review.method !== "string" ||
      checkedTime(review.checked_at) === "Not established" ||
      !Array.isArray(review.limitations) ||
      !review.limitations.every((item) => typeof item === "string") ||
      review.provider_requests_started !== 0
    )
      throw new Error(
        "The server returned an invalid source review. The previous result is unchanged.",
      );
  }
  // Build first, so malformed data never partially replaces a previous result.
  const hopNodes = renderHops(chain.hops);
  const assessmentNodes = renderAssessment(trace, packet);
  const reviewNodes = renderReview(review);
  const dateNodes = renderDates(trace, packet);
  const limitations = [
    ...new Set([...chain.limitations, ...(!saved ? packet.limitations : [])]),
  ];
  const limitationNodes = limitations.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  });
  const provenance = [
    ...metadataRow(
      "Research run",
      packet.provider_run_id || chain.provider_run_id || "Not established",
    ),
    ...metadataRow(
      "Research recorded",
      checkedTime(packet.recorded_at || chain.recorded_at),
    ),
    ...metadataRow("Trail verification", words(chain.verification)),
  ];
  provenance.push(
    ...metadataRow("Selected-page excerpt", words(trace.selection_quote_check)),
    ...metadataRow("Earliest source", words(trace.earliest_source_status)),
    ...metadataRow("Primary source", words(trace.primary_source_status)),
    ...(saved
      ? metadataRow("New provider operations", "0")
      : [
          ...metadataRow("Research jobs started", "1"),
          ...metadataRow(
            "Separate source-page checks",
            String(packet.source_page_checks),
          ),
          ...metadataRow(
            "Source-page check limit",
            String(packet.maximum_page_checks),
          ),
        ]),
  );
  result = packet;
  el("result-mode").textContent = saved
    ? "SAVED INVESTIGATION"
    : "FRESH CANDIDATE INVESTIGATION";
  el("result-context").textContent = saved
    ? "Recorded TinyResearch evidence. This action starts no new provider run or source-page retrieval."
    : `${packet.resumed_research ? "Reused the completed Research receipt; no new Research job. " : ""}Fresh candidate evidence from 1 TinyResearch job and ${packet.source_page_checks} separate TinyFetch source-page ${packet.source_page_checks === 1 ? "check" : "checks"}. Excerpt checks do not establish an earliest source or a human review.`;
  el("summary").textContent = chain.summary;
  el("provenance").replaceChildren(...provenance);
  el("assessment").replaceChildren(...assessmentNodes);
  el("assessment").hidden = !assessmentNodes.length;
  el("local-review").replaceChildren(...reviewNodes);
  el("local-review").hidden = !reviewNodes.length;
  el("dates").replaceChildren(...dateNodes);
  el("source-dates").hidden = !dateNodes.length;
  el("chain").replaceChildren(...hopNodes);
  el("limitations").replaceChildren(...limitationNodes);
  el("results").hidden = false;
  el("summary").focus();
}
async function investigate(saved, resume = false) {
  if (!selection || busy) return;
  const recoveryId = el("recovery-id").value.trim();
  if (resume && !investigationId.test(recoveryId)) return;
  busy = true;
  updateActions();
  const controller = saved ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
  let responseReceived = false;
  setState(
    saved
      ? "Looking for this exact saved selection…"
      : resume
        ? "Resuming source checks. No new Research job…"
        : "Tracing the source chain…",
  );
  try {
    const response = await fetch(
      `${LOCAL_ORIGIN}/api/source-hunter${saved ? "/recorded-match" : resume ? "/resume" : ""}`,
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          resume ? { selection, investigation_id: recoveryId } : selection,
        ),
        ...(controller ? { signal: controller.signal } : {}),
      },
    );
    responseReceived = true;
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error(
        "The local server returned an invalid response. The previous result is unchanged.",
      );
    if (!response.ok) {
      if (
        body.resume_available === true &&
        investigationId.test(body.investigation_id)
      ) {
        el("recovery-id").value = body.investigation_id;
        el("recovery").open = true;
      }
      if (response.status === 403) {
        connection.authorized = false;
        updateConnection();
      }
      if (saved && response.status === 404)
        throw new Error(
          "No saved investigation matches this selection and URL. No new research was started.",
        );
      if (body.code === "LIVE_DISABLED") {
        connection.live = false;
        updateConnection();
        throw new Error(
          "Fresh research is paused. Use a matching saved investigation instead.",
        );
      }
      throw new Error(
        typeof body.message === "string"
          ? body.message
          : "The investigation could not be loaded. The previous result is unchanged.",
      );
    }
    if (
      resume &&
      (body.investigation_id !== recoveryId ||
        body.resumed_research !== true ||
        body.new_research_jobs_started !== 0)
    )
      throw new Error(
        "The recovery acknowledgement does not match this receipt. The previous result is unchanged.",
      );
    render(body, saved);
    if (!saved) el("recovery").open = false;
    setState(
      saved
        ? "Matching saved investigation opened. No new TinyFish run."
        : resume
          ? "Source checks completed from the saved receipt. No new Research job."
          : "Research response received. Its evidence gaps remain visible.",
    );
  } catch (error) {
    if (!responseReceived) {
      connection = {
        state: "offline",
        live: false,
        configured: false,
        count: 0,
      };
      updateConnection();
    }
    setState(
      controller?.signal.aborted
        ? "Saved lookup timed out. No new research was started; the previous result is unchanged."
        : !responseReceived
          ? "The local server could not be reached. Recheck its connection; the previous result is unchanged."
          : error instanceof Error
            ? error.message
            : "The local server is unavailable.",
      true,
    );
  } finally {
    if (timer) clearTimeout(timer);
    busy = false;
    updateActions();
  }
}
el("recorded").addEventListener("click", () => investigate(true));
el("trace").addEventListener("click", () => investigate(false));
el("resume").addEventListener("click", () => investigate(false, true));
el("recovery-id").addEventListener("input", updateActions);
el("retry-connection").addEventListener("click", checkConnection);
el("download").addEventListener("click", () => {
  if (!result) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "source-hunter-investigation.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
el("extension-id").textContent =
  typeof chrome === "undefined"
    ? "Available after installing this extension"
    : chrome.runtime.id;
await Promise.all([captureSelection(), checkConnection()]);
