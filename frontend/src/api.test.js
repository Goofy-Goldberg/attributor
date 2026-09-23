import { describe, expect, it } from "vitest";

import {
  confidenceFromScore,
  normalizeConnectionPairs,
  normalizeConnectionsGraph,
  normalizeExplorerGraph,
  normalizeGraphClusters,
  normalizeGraphLinks,
  normalizeGraphPath,
  normalizeJob,
  normalizePool,
  normalizeRelatedThrough,
  normalizeSearchResults,
  normalizeSelectorGroups,
  normalizeSelectorKinds,
} from "./api.js";

describe("API payload normalizers", () => {
  it("normalizes jobs from nested payloads and derives progress from steps", () => {
    const job = normalizeJob({
      job: {
        job_id: "scan-7",
        state: "IN_PROGRESS",
        completedSteps: 1,
        totalSteps: 4,
        description: { text: "Resolving hosts" },
        events: ["queued", { timestamp: "2026-09-23T10:00:00Z", severity: "WARN", message: "slow DNS" }],
        stages: [{ key: "dns", title: "DNS", state: "DONE" }],
      },
    });

    expect(job).toMatchObject({
      id: "scan-7",
      status: "in-progress",
      percent: 25,
      summary: "Resolving hosts",
      logs: [
        { id: "log-0", level: "info", message: "queued" },
        { level: "warn", message: "slow DNS" },
      ],
      steps: [{ id: "dns", label: "DNS", status: "done" }],
    });
    expect(normalizeJob(null, "fallback")).toMatchObject({ id: "fallback", status: "unknown", percent: null });
  });

  it("normalizes direct graph links and preserves evidence context", () => {
    const [link] = normalizeGraphLinks({
      links: [
        {
          registrable_domain: "beta.example",
          score: "65",
          confidence: "0.8",
          sharedNodeCount: 1,
          evidence: [
            {
              nodeType: "network",
              kind: "shared_ip",
              value: "203.0.113.7",
              sources: [{ domain: "alpha.example" }],
              windowA: ["2026-01-01", "2026-02-01"],
              hostsA: ["a.alpha.example"],
              cloudflare: true,
            },
          ],
        },
      ],
    });

    expect(link).toMatchObject({
      target: "beta.example",
      score: 65,
      confidence: 80,
      sharedNodeCount: 1,
      evidence: [
        {
          nodeType: "network",
          kind: "shared_ip",
          value: "203.0.113.7",
          sources: ["alpha.example"],
          windowA: ["2026-01-01", "2026-02-01"],
          hostsA: ["a.alpha.example"],
          cloudflare: true,
        },
      ],
    });
    expect(confidenceFromScore(65)).toBe(50);
    expect(confidenceFromScore("bad")).toBe(0);
  });

  it("normalizes pools, clusters, selectors, and search results from API field variants", () => {
    expect(normalizePool({ domains: [{ domain: { name: "alpha.example" }, hostCount: 3, ingested: true }, {}] })).toEqual([
      expect.objectContaining({ domain: "alpha.example", hostCount: 3, connectionCount: 0, ingested: true }),
    ]);
    expect(
      normalizeGraphClusters({
        clusters: [{ clusterId: "c1", members: ["alpha.example", { domain: "beta.example" }], links: [{ kind: "cert", value: "x" }] }],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "c1",
        size: 2,
        members: ["alpha.example", "beta.example"],
        linkCount: 1,
        links: [expect.objectContaining({ kind: "cert", value: "x" })],
      }),
    ]);
    expect(normalizeSelectorGroups({ groups: [{ kind: "dns", value: "ns1", domains: ["alpha.example", null] }] })).toEqual([
      { id: "dns-ns1", kind: "dns", value: "ns1", degree: null, domains: ["alpha.example"] },
    ]);
    expect(
      normalizeSearchResults({
        query: "alpha",
        domains: [{ domain: "alpha.example", connectionCount: 2 }],
        selectors: [{ kind: "cert", value: "abc", sampleDomains: ["alpha.example"] }],
      }),
    ).toEqual({
      query: "alpha",
      domains: [{ domain: "alpha.example", connectionCount: 2, clusterId: null, tier: null }],
      selectors: [{ id: "cert-abc", kind: "cert", value: "abc", domainCount: null, sampleDomains: ["alpha.example"] }],
    });
    expect(normalizeSelectorKinds({ kinds: [{ kind: "cert", groups: 3 }, {}] })).toEqual([{ kind: "cert", groups: 3 }]);
  });

  it("keeps connected pairs and graph edges aligned", () => {
    const payload = {
      pairs: [
        { a: "alpha.example", b: "beta.example", connected: true, score: 45, strength: "strong", evidence: [{ kind: "cert", value: "x" }] },
        { a: "alpha.example", b: "gamma.example", connected: false, score: 0 },
      ],
      tiers: { "alpha.example": 1, "beta.example": 2 },
    };

    expect(normalizeConnectionPairs(payload)).toEqual([
      expect.objectContaining({ a: "alpha.example", b: "beta.example", connected: true, score: 45 }),
      expect.objectContaining({ a: "alpha.example", b: "gamma.example", connected: false }),
    ]);
    expect(normalizeConnectionsGraph(payload, ["alpha.example", "beta.example"])).toEqual({
      nodes: [
        { id: "alpha.example", label: "alpha.example", role: "submitted", tier: 1 },
        { id: "beta.example", label: "beta.example", role: "submitted", tier: 2 },
      ],
      edges: [
        expect.objectContaining({
          from: "alpha.example",
          to: "beta.example",
          score: 45,
          visual: "strong",
          width: 3,
          labels: ["Cert: x"],
        }),
      ],
    });
  });

  it("adds pool and multi-hop related graph edges once", () => {
    const graph = normalizeExplorerGraph(
      {
        domains: ["alpha.example", "beta.example"],
        pairs: [{ a: "alpha.example", b: "beta.example", connected: true, score: 20 }],
        pool_links: {
          "alpha.example": [
            { target: "beta.example", score: 99 },
            { target: "gamma.example", score: 30, strength: "moderate" },
          ],
        },
      },
      new Map([
        [
          "alpha.example",
          [
            { target: "beta.example", hops: 2, minHopScore: 10, chain: [] },
            { target: "delta.example", hops: 3, minHopScore: 15, chain: [{ to: "middle.example" }, { to: "delta.example" }] },
          ],
        ],
      ]),
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(["alpha.example", "beta.example", "gamma.example", "delta.example"]);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "alpha.example", to: "beta.example", direct: true, score: 20 }),
        expect.objectContaining({ from: "alpha.example", to: "gamma.example", visual: "moderate" }),
        expect.objectContaining({ from: "alpha.example", to: "delta.example", direct: false, hops: 3, labels: ["3-hop chain via middle.example"] }),
      ]),
    );
  });

  it("normalizes precomputed paths and related-through chains", () => {
    expect(
      normalizeGraphPath({
        path: {
          a: "alpha.example",
          b: "gamma.example",
          hops: 2,
          chain: [{ from: "alpha.example", to: "beta.example", score: "65", evidence: [{ kind: "cert", value: "x" }] }, { from: "bad" }],
        },
      }),
    ).toMatchObject({
      a: "alpha.example",
      b: "gamma.example",
      hops: 2,
      chain: [{ from: "alpha.example", to: "beta.example", score: 65, confidence: 50 }],
    });
    expect(
      normalizeRelatedThrough({ related: [{ target: "gamma.example", hops: 2, minHopScore: 30, chain: [{ from: "alpha.example", to: "beta.example" }] }, {}] }),
    ).toEqual([
      expect.objectContaining({ target: "gamma.example", hops: 2, minHopScore: 30, chain: [expect.objectContaining({ from: "alpha.example", to: "beta.example" })] }),
    ]);
  });
});
