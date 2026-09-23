import { describe, expect, it } from "vitest";

import {
  comparisonSelectionKey,
  comparisonViewState,
  isCurrentComparisonRequest,
} from "./ComparePage.jsx";

const result = { domains: ["alpha.example", "beta.example"], pairs: [] };

describe("comparison request freshness", () => {
  it("hides a completed result as soon as the selection changes", () => {
    const previous = {
      key: comparisonSelectionKey(["alpha.example"]),
      result,
      seedDomains: ["alpha.example"],
      relatedChains: new Map([["alpha.example", [{ target: "beta.example", hops: 2 }]]]),
      busy: false,
      error: null,
      partialWarning: null,
    };

    expect(comparisonViewState(previous, ["beta.example"])).toMatchObject({
      result: null,
      seedDomains: [],
      busy: false,
      ready: false,
      error: null,
      partialWarning: null,
    });
  });

  it("rejects a late response from the request that the debounced replacement superseded", () => {
    const oldRequest = { id: 4, key: comparisonSelectionKey(["alpha.example"]) };
    const currentRequest = { id: 5, key: comparisonSelectionKey(["beta.example"]) };

    expect(isCurrentComparisonRequest(oldRequest, currentRequest, currentRequest.key)).toBe(false);
    expect(isCurrentComparisonRequest(currentRequest, currentRequest, currentRequest.key)).toBe(true);
  });

  it("keeps an in-flight replacement unavailable to export until it succeeds", () => {
    const replacement = {
      key: comparisonSelectionKey(["beta.example"]),
      result,
      seedDomains: ["beta.example"],
      relatedChains: new Map(),
      busy: true,
      error: null,
      partialWarning: null,
    };

    expect(comparisonViewState(replacement, ["beta.example"])).toMatchObject({
      result,
      busy: true,
      ready: false,
    });
  });

  it("does not retain a result after the replacement fails", () => {
    const failed = {
      key: comparisonSelectionKey(["beta.example"]),
      result: null,
      seedDomains: [],
      relatedChains: new Map(),
      busy: false,
      error: "Graph service unavailable",
      partialWarning: null,
    };

    expect(comparisonViewState(failed, ["beta.example"])).toMatchObject({
      result: null,
      ready: false,
      error: "Graph service unavailable",
    });
  });
});
