import { describe, expect, it } from "vitest";

import { isNoisyEvidenceGroup, normalizeEvidenceGroups, rankEvidenceGroups } from "./EvidencePage.jsx";

describe("shared evidence presentation", () => {
  it("keeps optional server ranking and noise metadata with normalized groups", () => {
    expect(
      normalizeEvidenceGroups({
        groups: [
          {
            kind: "tracking_id",
            value: "rare",
            degree: 2,
            domains: ["alpha.example", "beta.example"],
            rarity: "1.0",
            attributing_weight: "9",
          },
          { kind: "shared_ip", value: "203.0.113.7", degree: 80, domains: ["alpha.example"], is_noise: true },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ rarity: 1, tellingness: null, attributingWeight: 9, noisy: false, noiseExplicit: false, attributing: null }),
      expect.objectContaining({ noisy: true, noiseExplicit: true, attributing: null }),
    ]);
  });

  it("puts rare and telling groups first and leaves common groups at the end", () => {
    const groups = normalizeEvidenceGroups({
      groups: [
        { kind: "shared_ip", value: "common", degree: 80, domains: ["a", "b"] },
        { kind: "tracking_id", value: "account", degree: 3, domains: ["a", "b", "c"], rarity: 0.7 },
        { kind: "tls_san", value: "rare", degree: 2, domains: ["a", "b"], rarity: 1 },
      ],
    });

    expect(rankEvidenceGroups(groups).map((group) => group.value)).toEqual(["rare", "account", "common"]);
    expect(isNoisyEvidenceGroup(groups[0])).toBe(true);
    expect(isNoisyEvidenceGroup(groups[1])).toBe(false);
  });

  it("uses an explicit attribution decision when a high degree is still meaningful", () => {
    expect(isNoisyEvidenceGroup({ degree: 100, attributing: true })).toBe(false);
    expect(isNoisyEvidenceGroup({ degree: 100, attributing: false })).toBe(true);
    expect(isNoisyEvidenceGroup({ degree: 100, noisy: false, noiseExplicit: true })).toBe(false);
  });
});
