import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApi } from "@/api.js";

import { RelatedThroughSection } from "./DomainPage.jsx";

vi.mock("@/api.js", async () => {
  const actual = await vi.importActual("@/api.js");
  return { ...actual, useApi: vi.fn() };
});

function renderSection(state) {
  useApi.mockReturnValue(state);
  return renderToStaticMarkup(
    <MemoryRouter>
      <RelatedThroughSection directTargets={new Set()} value="alpha.example" />
    </MemoryRouter>,
  );
}

describe("RelatedThroughSection request states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading while the precomputed lookup is pending", () => {
    const markup = renderSection({ data: null, error: null, loading: true });

    expect(markup).toContain("Indirect connections");
    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).not.toContain("No indirect connections");
  });

  it("shows a failure without treating it as an empty result", () => {
    const markup = renderSection({ data: null, error: "Graph service unavailable", loading: false });

    expect(markup).toContain("Could not load indirect connections");
    expect(markup).toContain("Graph service unavailable");
    expect(markup).not.toContain("No indirect connections");
  });

  it("shows a real empty state after a successful lookup", () => {
    const markup = renderSection({ data: { related: [] }, error: null, loading: false });

    expect(useApi).toHaveBeenCalledWith("/api/graph/related/alpha.example?min_hops=2");
    expect(markup).toContain("No indirect connections");
    expect(markup).toContain("No precomputed multi-hop paths remain");
  });

  it("does not call an empty first page complete when more paths exist", () => {
    const markup = renderSection({ data: { related: [], total: 60, limit: 50, has_more: true }, error: null, loading: false });

    expect(markup).toContain("More precomputed paths are available");
    expect(markup).not.toContain("No indirect connections");
  });
});
