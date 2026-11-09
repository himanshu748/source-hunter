const el = (id) => document.getElementById(id);
let result = null;
let freshEnabled = false;
let freshBusy = false;
const investigationId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function updateFreshActions() {
  el("submit").disabled = freshBusy || !freshEnabled;
  el("resume").disabled =
    freshBusy ||
    !freshEnabled ||
    !investigationId.test(el("recovery-id").value.trim());
  el("recovery-id").disabled = freshBusy;
}
el("example").addEventListener("click", () => {
  el("text").value =
    "In 2023, around 2.33 billion people globally faced moderate or severe food insecurity";
  el("url").value =
    "https://www.who.int/news/item/24-07-2024-hunger-numbers-stubbornly-high-for-three-consecutive-years-as-global-crises-deepen--un-report";
  el("title").value =
    "Hunger numbers stubbornly high for three consecutive years as global crises deepen: UN report";
  el("text").focus();
});
function paragraph(text) {
  const node = document.createElement("p");
  node.textContent = text;
  return node;
}
function referencedExcerpt(trace, excerpts, item) {
  if (!item.quote_ref?.startsWith(trace.id + ".")) return null;
  const prefix = trace.id + ".chain.hops.";
  if (item.quote_ref.startsWith(prefix) && item.quote_ref.endsWith(".quote")) {
    const index = item.quote_ref.slice(prefix.length, -6);
    if (/^\d+$/.test(index)) {
      const hop = trace.chain.hops[Number(index)];
      if (hop?.url === item.source_url) return hop.quote;
    }
  }
  return (
    excerpts.find(
      (entry) => entry.ref === item.quote_ref && entry.url === item.source_url,
    )?.quote ?? null
  );
}
function renderTrace(value) {
  document.getElementById("claim-assessment")?.remove();
  result = value;
  if (value.selection) {
    el("text").value = value.selection.text;
    el("url").value = value.selection.page_url;
    el("title").value = value.selection.page_title;
  }
  el("empty").hidden = true;
  el("result").hidden = false;
  el("summary").textContent = value.summary;
  el("badge").textContent = value.status.toUpperCase();
  el("chain").replaceChildren(
    ...value.hops.map((h) => {
      const li = document.createElement("li"),
        label = document.createElement("div"),
        link = document.createElement("a"),
        quote = document.createElement("p"),
        relationship = document.createElement("p");
      label.className = "hop-label";
      label.textContent =
        h.role.replaceAll("_", " ") +
        " · " +
        "excerpt " +
        h.quote_check.replaceAll("_", " ") +
        (h.link_to_next && h.link_to_next !== "not_applicable"
          ? " · link " + h.link_to_next.replaceAll("_", " ")
          : "");
      link.href = h.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = h.title;
      quote.textContent = h.quote + (h.excerpt_shortened ? "…" : "");
      relationship.textContent = h.relationship_to_next ?? "";
      const checked = paragraph(
        "Page checked: " + (h.checked_at ?? "Not established"),
      );
      checked.className = "hop-label";
      li.append(label, link, quote, relationship, checked);
      if (h.check_method)
        li.append(
          paragraph("Check method: " + h.check_method.replaceAll("_", " ")),
        );
      return li;
    }),
  );
  el("limitations").replaceChildren(
    ...value.limitations.map((x) => {
      const li = document.createElement("li");
      li.textContent = x;
      return li;
    }),
  );
  el("state").textContent =
    "Research saved. Review the source chain and its evidence gaps.";
}
async function investigateFresh(resume = false) {
  if (!freshEnabled || freshBusy) return;
  const recoveryId = el("recovery-id").value.trim();
  if (resume && !investigationId.test(recoveryId)) return;
  const selection = {
    text: el("text").value,
    page_url: el("url").value,
    page_title: el("title").value,
  };
  freshBusy = true;
  updateFreshActions();
  el("state").textContent = resume
    ? "Resuming source checks. No new Research job…"
    : "Following the references. Research may take several minutes…";
  el("badge").textContent = "TRACING";
  try {
    const response = await fetch(
      `/api/source-hunter${resume ? "/resume" : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          resume ? { selection, investigation_id: recoveryId } : selection,
        ),
      },
    );
    const value = await response.json();
    if (!response.ok) {
      if (value.code === "LIVE_DISABLED") freshEnabled = false;
      if (
        value.resume_available === true &&
        investigationId.test(value.investigation_id)
      ) {
        el("recovery-id").value = value.investigation_id;
        el("recovery").open = true;
      }
      throw new Error(
        value.code === "LIVE_DISABLED"
          ? "Live tracing is paused here. Explore the recorded trail instead."
          : value.resume_available
            ? "Research is saved. Fix the source-check connection, then use Resume source checks. No new Research job is needed."
            : "This trace could not be completed. Any existing result stays visible.",
      );
    }
    if (
      resume &&
      (value.investigation_id !== recoveryId ||
        value.resumed_research !== true ||
        value.new_research_jobs_started !== 0)
    )
      throw new Error(
        "The recovery acknowledgement does not match this receipt. The previous investigation stays visible.",
      );
    const normalize = (text) =>
      text.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const source = new URL(selection.page_url);
    source.hash = "";
    if (
      value.mode !== "fresh_research" ||
      value.trace?.selection?.page_url !== source.href ||
      normalize(value.trace.selection.text) !== normalize(selection.text)
    )
      throw new Error(
        "The response did not match this selection. The previous investigation stays visible.",
      );
    displayBatchTrace(value.trace, value);
    el("recovery").open = false;
  } catch (error) {
    el("state").textContent =
      error.message ?? "The local server could not be reached.";
    el("badge").textContent = "TRACE UNAVAILABLE";
  } finally {
    freshBusy = false;
    updateFreshActions();
  }
}
el("form").addEventListener("submit", (event) => {
  event.preventDefault();
  investigateFresh();
});
el("resume").addEventListener("click", () => investigateFresh(true));
el("recovery-id").addEventListener("input", updateFreshActions);
el("download").addEventListener("click", () => {
  if (!result) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "source-hunter-chain.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.dataset.motion === "reduced";
const heroDescriptions = [
  "WHO’s release links to the joint report landing page. The exact selection and its context are preserved.",
  "The landing page links the report’s DOI. Retrieval of that target remains a gap, not an invented redirect.",
  "An independent UNICEF copy of the joint report gives 2,325.5 million in Table 4. It supports the rounding to 2.33 billion, without establishing the earliest publication.",
];
let heroStep = 0;
function selectHeroStep(index) {
  heroStep = index;
  document.querySelectorAll("[data-source-step]").forEach((button, i) => {
    button.classList.toggle("is-active", i === index);
    button.setAttribute("aria-pressed", String(i === index));
  });
  el("hero-step-index").textContent =
    String(index + 1).padStart(2, "0") + "—03";
  el("hero-step-detail").textContent = heroDescriptions[index];
}
document
  .querySelectorAll("[data-source-step]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      selectHeroStep(Number(button.dataset.sourceStep)),
    ),
  );
el("hero-next").addEventListener("click", () =>
  selectHeroStep((heroStep + 1) % 3),
);
const extensionDialog = el("extension-dialog");
document
  .querySelectorAll("[data-open-extension]")
  .forEach((button) =>
    button.addEventListener("click", () => extensionDialog.showModal()),
  );
el("hero-recorded").addEventListener("click", async () => {
  try {
    const batch = await recordedBatchPromise;
    if (!batch?.traces?.length) throw new Error("unavailable");
    displayBatchTrace(batch.traces[0], batch);
    el("trace").scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  } catch {
    el("state").textContent =
      "The recorded investigation is unavailable. No new research was started.";
    el("trace").scrollIntoView({ behavior: "auto", block: "start" });
  }
});

const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
let manualReduced = false;
function syncMotion() {
  const reduced = motionMedia.matches || manualReduced;
  document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  const button = el("motion-toggle");
  if (!button) return;
  button.textContent = motionMedia.matches
    ? "Motion: reduced (system)"
    : reduced
      ? "Motion: reduced"
      : "Motion: on";
  button.setAttribute("aria-pressed", String(reduced));
  button.disabled = motionMedia.matches;
}
el("motion-toggle")?.addEventListener("click", () => {
  manualReduced = !manualReduced;
  syncMotion();
});
motionMedia.addEventListener("change", syncMotion);
syncMotion();

function displayBatchTrace(trace, batch) {
  const saved = batch.mode !== "fresh_research";
  const picker = el("recorded-trace-select");
  if (picker) picker.value = saved ? trace.id : "";
  const excerpts = batch.excerpts ?? [];
  renderTrace(trace.chain);
  result = saved
    ? {
        mode: "recorded_research",
        provider_run_id: batch.provider_run_id,
        recorded_at: batch.recorded_at,
        provider_requests_started: 0,
        trace,
        excerpts: excerpts.filter((item) =>
          item.ref.startsWith(trace.id + "."),
        ),
        ...(batch.local_review ? { local_review: batch.local_review } : {}),
      }
    : batch;
  el("text").value = trace.selection.text;
  el("url").value = trace.selection.page_url;
  el("title").value = trace.selection.page_title;
  const panel = document.createElement("section");
  panel.id = "claim-assessment";
  panel.className = "claim-assessment";
  const heading = document.createElement("h3");
  heading.textContent =
    "Claim assessment: " + trace.assessment.label.replaceAll("_", " ");
  const reason = document.createElement("p");
  reason.textContent = trace.assessment.reason;
  const note = document.createElement("p");
  note.className = "hop-label";
  note.textContent =
    (saved ? "Recorded research · " : "Fresh research · ") +
    (trace.assessment.scope ?? "source comparison").replaceAll("_", " ") +
    " · earliest source: " +
    (trace.earliest_source_status ?? "unresolved").replaceAll("_", " ");
  panel.append(heading, reason, note);
  if (trace.primary_source_status)
    panel.append(
      paragraph(
        "Primary source: " + trace.primary_source_status.replaceAll("_", " "),
      ),
    );
  if (trace.context) panel.append(paragraph(trace.context));
  const evidenceList = document.createElement("ul");
  for (const evidence of trace.assessment.evidence ?? []) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = evidence.source_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent =
      new URL(evidence.source_url).hostname +
      " · " +
      evidence.stance +
      " · excerpt " +
      evidence.quote_check.replaceAll("_", " ");
    item.append(link);
    const quote = referencedExcerpt(trace, excerpts, evidence);
    if (quote) {
      const text = document.createElement("p");
      text.textContent = "“" + quote + "”";
      item.append(text);
    }
    evidenceList.append(item);
  }
  if (evidenceList.childElementCount) panel.append(evidenceList);
  if (trace.assessment.research_explanation) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Researcher's explanation (proposed)";
    const explanation = document.createElement("p");
    explanation.textContent = trace.assessment.research_explanation;
    details.append(summary, explanation);
    panel.append(details);
  }
  const dates = document.createElement("ul");
  for (const date of trace.dates ?? []) {
    const item = document.createElement("li");
    item.textContent = `${date.kind.replaceAll("_", " ")}: ${date.value ?? "Unknown"} · ${date.precision} precision · ${date.check.replaceAll("_", " ")}`;
    if (date.source_url) {
      const link = document.createElement("a");
      link.href = date.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = new URL(date.source_url).hostname;
      item.append(" · ", link);
    }
    const excerpt = referencedExcerpt(trace, excerpts, date);
    if (excerpt) item.append(paragraph("“" + excerpt + "”"));
    dates.append(item);
  }
  if (dates.childElementCount) panel.append(dates);
  const review = trace.local_review ?? batch.local_review;
  if (review) {
    const reviewHeading = document.createElement("h3");
    reviewHeading.textContent = "What the source review established";
    panel.append(reviewHeading, paragraph(review.summary));
    if (review.limitations?.length) {
      const limits = document.createElement("ul");
      for (const note of review.limitations) {
        const li = document.createElement("li");
        li.textContent = note;
        limits.append(li);
      }
      panel.append(limits);
    }
  }
  const provenance = document.createElement("details");
  const provenanceHeading = document.createElement("summary");
  provenanceHeading.textContent = saved
    ? "About this saved investigation"
    : "About this research run";
  const metadata = document.createElement("dl");
  metadata.className = "run-provenance";
  for (const [label, value] of [
    ["Research recorded", batch.recorded_at],
    ["Research run", batch.provider_run_id],
    ["Review record", review?.checked_at ?? "No later review"],
    ...(saved
      ? [["New provider requests", "0"]]
      : [
          ["Research jobs started", String(batch.research_jobs_started)],
          ["Source page checks", String(batch.source_page_checks)],
        ]),
  ]) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    metadata.append(dt, dd);
  }
  provenance.append(provenanceHeading, metadata);
  panel.append(provenance);
  el("summary").after(panel);
  el("badge").textContent = saved ? "SAVED INVESTIGATION" : "RESEARCH RESPONSE";
  el("state").textContent = saved
    ? "Recorded claim loaded. No new research run was started."
    : batch.resumed_research
      ? "Source checks completed from the saved Research receipt. No new Research job. Review the remaining gaps."
      : "Research completed. Review the checked wording, proposed assessment and remaining gaps.";
}

const recordedBatchPromise = fetch("/recorded-traces.json")
  .then(async (response) => (response.ok ? response.json() : null))
  .then((batch) => {
    if (!batch?.traces?.length) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "recorded-picker";
    const label = document.createElement("label");
    label.htmlFor = "recorded-trace-select";
    label.textContent = "Explore a recorded claim";
    const select = document.createElement("select");
    select.id = "recorded-trace-select";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a real selection…";
    select.append(placeholder);
    for (const trace of batch.traces) {
      const option = document.createElement("option");
      option.value = trace.id;
      option.textContent = trace.selection.page_title;
      select.append(option);
    }
    select.addEventListener("change", () => {
      const trace = batch.traces.find((item) => item.id === select.value);
      if (trace) displayBatchTrace(trace, batch);
    });
    const hint = document.createElement("p");
    hint.textContent = `${batch.traces.length} real selections from one saved research batch. Evidence gaps stay visible.`;
    wrapper.append(label, select, hint);
    el("form").before(wrapper);
    return batch;
  })
  .catch(() => null);

fetch("/health")
  .then((response) => (response.ok ? response.json() : null))
  .then((health) => {
    freshEnabled = health?.mode === "live_enabled";
    updateFreshActions();
    if (!result && !freshEnabled)
      el("state").textContent = health
        ? "Fresh tracing is paused. Explore a saved investigation; preparing a selection starts no research."
        : "The local service is unavailable. No research was started.";
  })
  .catch(() => {
    updateFreshActions();
  });
