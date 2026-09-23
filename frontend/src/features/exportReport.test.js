import { describe, expect, it } from "vitest";

import { buildReportCsv, buildReportHtml, describeVerdictSummary } from "./exportReport.js";

const verdictSummary = {
  counts: { same_owner: 1, different_owner: 1, unsure: 0 },
  verdicts: [
    { userDisplay: "Ada", verdict: "same_owner", note: "Shared registration ID." },
    { userDisplay: "Lin", verdict: "different_owner", note: "Shared hosting only." },
  ],
};

describe("connection report verdict exports", () => {
  it("states analyst disagreement in the printable report", () => {
    const html = buildReportHtml({
      title: "Pair report",
      pairs: [{ a: "alpha.example", b: "beta.example", connected: true, score: 40, evidence: [], verdictSummary }],
    });

    expect(describeVerdictSummary(verdictSummary)).toBe("Analysts disagree (Same owner: 1, Different owner: 1).");
    expect(html).toContain("Analyst verdicts");
    expect(html).toContain("Ada: Same owner — Shared registration ID.");
    expect(html).toContain("Lin: Different owner — Shared hosting only.");
  });

  it("includes a manually labelled zero-score pair with explicit verdict counts in CSV", () => {
    const csv = buildReportCsv({
      pairs: [{ a: "alpha.example", b: "beta.example", connected: false, score: 0, evidence: [], verdictSummary }],
    });

    expect(csv).toContain("same_owner_verdicts,different_owner_verdicts,unsure_verdicts,analyst_verdicts");
    expect(csv).toContain("alpha.example,beta.example,1,0,,,,,1,1,0,Ada: Same owner — Shared registration ID.; Lin: Different owner — Shared hosting only.");
  });
});
