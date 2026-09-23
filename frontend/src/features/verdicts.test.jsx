import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ConnectionRow } from "./evidence.jsx";
import { PairsPanel } from "@/pages/ComparePage.jsx";

describe("pair verdicts", () => {
  it("shows verdict counts and makes an analyst disagreement explicit", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ConnectionRow
          defaultOpen
          leftLabel="alpha.example"
          link={{
            score: 40,
            evidence: [],
            target: "beta.example",
            verdictSummary: {
              counts: { same_owner: 2, different_owner: 1, unsure: 0 },
              verdicts: [
                { id: "v1", userDisplay: "Ada", verdict: "same_owner", note: "Shared registration ID.", evidenceKinds: [] },
                { id: "v2", userDisplay: "Lin", verdict: "different_owner", note: "Shared hosting only.", evidenceKinds: [] },
              ],
            },
          }}
          rightLabel="beta.example"
          showPair
        />
      </MemoryRouter>,
    );

    expect(markup).toContain("Same owner 2");
    expect(markup).toContain("Different owner 1");
    expect(markup).toContain("Analysts disagree: 2 same owner, 1 different owner.");
    expect(markup).toContain("Shared hosting only.");
  });

  it("keeps a zero-score comparison pair openable for an analyst verdict", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PairsPanel
          expandedCount={0}
          pairs={[{ a: "alpha.example", b: "beta.example", connected: false, score: 0, evidence: [] }]}
          seedSet={new Set(["alpha.example", "beta.example"])}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain("No shared evidence (1)");
    expect(markup).toContain("alpha.example");
    expect(markup).toContain('data-slot="collapsible-trigger"');
  });
});
