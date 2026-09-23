import { describe, expect, it } from "vitest";

import {
  DEFAULT_POOL_FILTERS,
  advancedFilterCount,
  buildPoolQuery,
  filtersFromParams,
  getPoolPageMeta,
  pageFromParams,
  poolFiltersActive,
  writeFilterParams,
} from "./poolQuery.js";

describe("pool query helpers", () => {
  it("reads defaults and valid filter values from a shareable URL", () => {
    expect(filtersFromParams(new URLSearchParams("q=alpha&min=2&sort=connections"))).toEqual({
      ...DEFAULT_POOL_FILTERS,
      search: "alpha",
      minConnections: "2",
      sort: "connections",
    });
    expect(pageFromParams(new URLSearchParams("page=3"))).toBe(3);
    expect(pageFromParams(new URLSearchParams("page=0"))).toBe(1);
    expect(pageFromParams(new URLSearchParams("page=1.5"))).toBe(1);
  });

  it("writes only non-default filters and resets pagination at page one", () => {
    const params = writeFilterParams(
      new URLSearchParams("stale=keep&page=7&q=old"),
      { ...DEFAULT_POOL_FILTERS, search: "alpha beta", provenance: "ingested", minConnections: 4 },
    );

    expect(params.toString()).toBe("stale=keep&q=alpha+beta&provenance=ingested&min=4");
  });

  it("builds the API query with optional filters and a page offset", () => {
    expect(
      buildPoolQuery(
        { ...DEFAULT_POOL_FILTERS, search: "alpha beta", maxConnections: 9, discoveredAfter: "2026-01-01" },
        3,
        25,
      ),
    ).toBe("/api/pool?search=alpha+beta&max_connections=9&discovered_after=2026-01-01&limit=25&offset=50");
    expect(buildPoolQuery()).toBe("/api/pool?limit=50&offset=0");
  });

  it("summarizes active filters and backend pagination metadata", () => {
    const filters = { ...DEFAULT_POOL_FILTERS, provenance: "discovered", minConnections: "3" };
    expect(advancedFilterCount(filters)).toBe(1);
    expect(poolFiltersActive(filters)).toBe(true);
    expect(poolFiltersActive({ ...DEFAULT_POOL_FILTERS, sort: "connections" })).toBe(false);

    expect(getPoolPageMeta({ total: "81", offset: "50", limit: "25" }, 25, 3, 25)).toEqual({
      total: 81,
      offset: 50,
      limit: 25,
      page: 3,
      pageCount: 4,
      start: 51,
      end: 75,
    });
    expect(getPoolPageMeta({}, 0)).toMatchObject({ total: 0, start: 0, end: 0, pageCount: 1 });
  });
});
