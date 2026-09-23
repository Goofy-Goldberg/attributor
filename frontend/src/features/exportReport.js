import { linkStrength, sharedNodeLabel } from "./evidence.jsx";

// Point-in-time export of what's currently on screen -- a plain-language
// report (printable HTML, no PDF library -- the browser's own "Save as PDF"
// does the conversion) and a structured CSV/JSON dump. Deliberately NOT a
// graph image and NOT a persisted/shared link: these are one-shot downloads
// built from data already loaded in the browser, same download pattern as
// ClusterGraph's PNG/HTML export (a Blob + a synthetic <a download>).

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously after .click() races the browser's own read of the
  // blob and drops the download outright in Firefox and Safari. One turn of
  // the event loop is enough for the navigation to have been queued.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// One plain-language sentence for a direct match, with its score and evidence.
function describeLink(link, leftLabel, rightLabel) {
  const strength = linkStrength(link);
  const kinds = [...new Set((link.evidence || []).map((node) => sharedNodeLabel(node.kind)))];
  const evidenceText = kinds.length > 0 ? ` via ${kinds.join(", ")}` : "";
  return `${leftLabel} and ${rightLabel} share evidence (${strength.label.toLowerCase()} evidence, match score ${Math.round(link.score ?? 0)})${evidenceText}.`;
}

export function describeVerdictSummary(summary) {
  const counts = summary?.counts || {};
  const labels = [
    ["same_owner", "Same owner"],
    ["different_owner", "Different owner"],
    ["unsure", "Unsure"],
  ].filter(([value]) => counts[value] > 0);
  if (labels.length === 0) {
    return "";
  }
  const text = labels.map(([value, label]) => `${label}: ${counts[value]}`).join(", ");
  return labels.length > 1 ? `Analysts disagree (${text}).` : `Analyst verdict: ${text}.`;
}

function verdictDetails(summary) {
  return (summary?.verdicts || [])
    .map((entry) => {
      const name = entry.userDisplay || entry.userId || "Analyst";
      const label = entry.verdict === "same_owner" ? "Same owner" : entry.verdict === "different_owner" ? "Different owner" : "Unsure";
      return `${name}: ${label}${entry.note ? ` — ${entry.note}` : ""}`;
    })
    .join("; ");
}

// `coverage` is deliberately part of the export contract. Screens pass the
// exact server totals and any path traversal limit they received, so a file
// remains honest after it leaves the application.
export function describeExportCoverage(coverage) {
  if (!coverage) {
    return "This export contains the relationships loaded on screen.";
  }
  const notes = [];
  const direct = coverage.direct;
  if (direct?.hasMore) {
    notes.push(direct.total == null
      ? `This export includes ${direct.shown ?? 0} loaded direct connections; more pool connections were not loaded.`
      : `It includes ${direct.shown ?? 0} of ${direct.total} direct connections.`);
  }
  const paths = coverage.paths;
  if (paths?.hasMore) {
    notes.push(`Only ${paths.shown ?? 0} of ${paths.total} precomputed paths were loaded before this export.`);
  }
  if (paths?.partial) {
    const limits = paths.pathLimits || {};
    const details = [];
    if (limits.max_hops) details.push(`up to ${limits.max_hops} hops`);
    if (limits.max_nodes) details.push(`${limits.max_nodes} reachable channels per source`);
    if (limits.frontier_limit) details.push(`${limits.frontier_limit} direct links per step`);
    notes.push(`Some possible paths were not checked${details.length ? ` (${details.join(", ")})` : ""}.`);
  }
  if (paths?.failed) {
    notes.push("Some precomputed path lookups failed, so indirect connections may be missing.");
  }
  if (paths?.stale) {
    notes.push("The path index was waiting for its next rebuild, so newer connections may be absent.");
  }
  if (coverage.selection?.truncated) {
    notes.push(`The graph scored ${coverage.selection.shown ?? 0} of ${coverage.selection.total} selected channels.`);
  }
  return notes.length > 0 ? notes.join(" ") : "This export contains the relationships loaded on screen.";
}

// Each score describes one pairwise match in the chain, not the endpoints.
function describeChainLines(chain) {
  return (chain || []).map((hop) => {
    const strength = linkStrength(hop);
    const kinds = [...new Set((hop.evidence || []).map((node) => sharedNodeLabel(node.kind)))];
    const evidenceText = kinds.length > 0 ? ` via ${kinds.join(", ")}` : "";
    return `${hop.from} → ${hop.to}${evidenceText} (${strength.label.toLowerCase()} evidence, match score ${Math.round(hop.score ?? 0)})`;
  });
}

// `scope`: { title, domains: string[], pairs: normalizedLink[] (a/b/connected/evidence/score/...),
//            chains: [{ a, b, hops, chain }] } -- chains is optional, for multi-hop
// relationships found via /api/graph/path or /api/graph/related/*.
export function buildReportHtml(scope) {
  const { title, domains = [], pairs = [], chains = [] } = scope || {};
  const coverage = describeExportCoverage(scope?.coverage);
  const connectedPairs = pairs.filter((pair) => pair.connected);

  const pairSentences = connectedPairs
    .map((pair) => `<li>${escapeHtml(describeLink(pair, pair.a, pair.b))}</li>`)
    .join("\n");

  const chainSections = chains
    .filter((entry) => entry.chain && entry.chain.length > 0)
    .map((entry) => {
      const lines = describeChainLines(entry.chain)
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join("\n");
      return `
        <div class="chain">
          <h3>${escapeHtml(entry.a)} → ${escapeHtml(entry.b)} (${entry.hops} hop${entry.hops === 1 ? "" : "s"})</h3>
          <ol>${lines}</ol>
        </div>`;
    })
    .join("\n");

  const verdictRows = pairs
    .flatMap((pair) => {
      if (!describeVerdictSummary(pair.verdictSummary)) {
        return [];
      }
      const details = verdictDetails(pair.verdictSummary);
      return [`<li><strong>${escapeHtml(pair.a)} ↔ ${escapeHtml(pair.b)}</strong>: ${escapeHtml(describeVerdictSummary(pair.verdictSummary))}${details ? `<br />${escapeHtml(details)}` : ""}</li>`];
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || "Connection report")}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f1a24; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1.05rem; margin-top: 32px; border-bottom: 1px solid #d7dde3; padding-bottom: 6px; }
  h3 { font-size: 0.95rem; margin: 20px 0 6px; }
  .meta { color: #5a6b78; font-size: 0.85rem; margin-bottom: 24px; }
  ul, ol { padding-left: 22px; }
  li { margin-bottom: 6px; }
  .chain { margin-bottom: 18px; }
  .domains { color: #5a6b78; font-size: 0.85rem; }
  @media print {
    body { margin: 0; max-width: none; }
  }
</style>
</head>
<body>
  <h1>${escapeHtml(title || "Connection report")}</h1>
  <p class="meta">Generated ${escapeHtml(todayLabel())}</p>
  <p class="domains">Channels covered: ${domains.map((d) => escapeHtml(d)).join(", ")}</p>
  <p class="domains">${escapeHtml(coverage)}</p>
  <p>A higher match score means more shared evidence. It is not a probability of common ownership.</p>

  <h2>Direct connections (${connectedPairs.length})</h2>
  ${connectedPairs.length > 0 ? `<ul>${pairSentences}</ul>` : "<p>No direct evidence-backed connections among these channels.</p>"}

  ${verdictRows ? `<h2>Analyst verdicts</h2><p>Each analyst's assessment is retained. More than one verdict type means analysts disagree.</p><ul>${verdictRows}</ul>` : ""}

  ${chainSections ? `<h2>Multi-hop relationships</h2><p>Each step is a separate match between two channels. A chain describes an indirect path; it does not give one match score for its endpoints.</p>${chainSections}` : ""}
</body>
</html>`;
}

// Opens the report in a new tab and triggers the browser's print dialog --
// "Save as PDF" from there produces the PDF. No PDF-generation library.
export function printReport(scope) {
  const html = buildReportHtml(scope);
  const win = window.open("", "_blank");
  if (!win) {
    return false;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // Give the new document a tick to lay out before invoking print.
  setTimeout(() => win.print(), 200);
  return true;
}

function csvField(value) {
  let text = String(value ?? "");
  // Values here are domain names and evidence strings harvested from hostile
  // sites, and this CSV is explicitly built to be handed to someone else. A
  // leading =, +, - or @ makes Excel/Sheets treat the cell as a formula and
  // evaluate it on open. Prefixing an apostrophe forces it back to text.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = [
  "domain_a",
  "domain_b",
  "hops",
  "score",
  "confidence",
  "strength",
  "shared_node_kind",
  "shared_node_value",
  "same_owner_verdicts",
  "different_owner_verdicts",
  "unsure_verdicts",
  "analyst_verdicts",
  "coverage",
];

function verdictCsvFields(summary) {
  if (!describeVerdictSummary(summary)) {
    return ["", "", "", ""];
  }
  const counts = summary?.counts || {};
  return [counts.same_owner ?? 0, counts.different_owner ?? 0, counts.unsure ?? 0, verdictDetails(summary)];
}

// One row per shared-evidence item (a pair with 3 shared selectors becomes 3
// rows); a connected pair with no evidence rows (e.g. inferred-only) still
// gets a single summary row.
export function buildReportCsv(scope) {
  const { pairs = [], chains = [] } = scope || {};
  const coverage = describeExportCoverage(scope?.coverage);
  const rows = [CSV_HEADER.join(",")];

  pairs
    .filter((pair) => pair.connected || describeVerdictSummary(pair.verdictSummary))
    .forEach((pair) => {
      const evidence = pair.evidence || [];
      if (evidence.length === 0) {
        rows.push(
          [pair.a, pair.b, 1, Math.round(pair.score ?? 0), pair.confidence ?? "", pair.strength ?? "", "", "", ...verdictCsvFields(pair.verdictSummary), coverage]
            .map(csvField)
            .join(","),
        );
        return;
      }
      evidence.forEach((node) => {
        rows.push(
          [pair.a, pair.b, 1, Math.round(pair.score ?? 0), pair.confidence ?? "", pair.strength ?? "", node.kind, node.value, ...verdictCsvFields(pair.verdictSummary), coverage]
            .map(csvField)
            .join(","),
        );
      });
    });

  chains.forEach((entry) => {
    (entry.chain || []).forEach((hop) => {
      const evidence = hop.evidence && hop.evidence.length > 0 ? hop.evidence : [{ kind: "", value: "" }];
      evidence.forEach((node) => {
        rows.push(
          [entry.a, entry.b, entry.hops, Math.round(hop.score ?? 0), hop.confidence ?? "", hop.strength ?? "", node.kind, node.value, ...verdictCsvFields(hop.verdictSummary), coverage]
            .map(csvField)
            .join(","),
        );
      });
    });
  });

  if (rows.length === 1) {
    rows.push(Array(CSV_HEADER.length - 1).fill("").concat(coverage).map(csvField).join(","));
  }

  // CRLF: Excel on Windows mis-parses LF-only files containing quoted
  // multi-line fields, which evidence strings can be.
  return rows.join("\r\n");
}

export function buildReportJson(scope) {
  return JSON.stringify({
    ...(scope || {}),
    exportCoverage: describeExportCoverage(scope?.coverage),
  }, null, 2);
}

export function downloadReportCsv(scope, filenameBase = "connection-report") {
  downloadBlob(buildReportCsv(scope), `${filenameBase}-${Date.now()}.csv`, "text/csv;charset=utf-8");
}

export function downloadReportJson(scope, filenameBase = "connection-report") {
  downloadBlob(buildReportJson(scope), `${filenameBase}-${Date.now()}.json`, "application/json;charset=utf-8");
}
