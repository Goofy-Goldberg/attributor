export const DEFAULT_POOL_FILTERS = {
  search: "",
  labels: [],
  provenance: "all",
  sort: "recent",
  minConnections: "",
  maxConnections: "",
  discoveredAfter: "",
  discoveredBefore: "",
  ingestedAfter: "",
  ingestedBefore: "",
};

export const DEFAULT_PAGE_SIZE = 50;

// Filter key <-> short URL param. Filters live in the query string so a view
// of the pool can be linked, and Back returns to the same filtered page.
const URL_KEYS = {
  search: "q",
  labels: "label",
  provenance: "provenance",
  sort: "sort",
  minConnections: "min",
  maxConnections: "max",
  discoveredAfter: "discovered_after",
  discoveredBefore: "discovered_before",
  ingestedAfter: "ingested_after",
  ingestedBefore: "ingested_before",
};

export function filtersFromParams(params) {
  return Object.fromEntries(
    Object.entries(DEFAULT_POOL_FILTERS).map(([key, fallback]) => [
      key, key === "labels" ? [...new Set(params.getAll("label").filter(Boolean))] : params.get(URL_KEYS[key]) ?? fallback,
    ]),
  );
}

export function pageFromParams(params) {
  const page = Number(params.get("page"));
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function writeFilterParams(params, filters, page = 1) {
  const next = new URLSearchParams(params);
  Object.entries(DEFAULT_POOL_FILTERS).forEach(([key, fallback]) => {
    const value = filters[key];
    if (key === "labels") {
      next.delete("label");
      [...new Set(value || [])].forEach((label) => next.append("label", label));
      return;
    }
    if (value === undefined || value === null || value === "" || value === fallback) {
      next.delete(URL_KEYS[key]);
    } else {
      next.set(URL_KEYS[key], String(value));
    }
  });
  if (page > 1) {
    next.set("page", String(page));
  } else {
    next.delete("page");
  }
  return next;
}

export function buildPoolQuery(filters = DEFAULT_POOL_FILTERS, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const params = new URLSearchParams();
  const offset = Math.max(0, (Number(page) || 1) - 1) * pageSize;

  appendParam(params, "search", filters.search);
  (filters.labels || []).forEach((label) => params.append("label", label));
  appendParam(params, "provenance", filters.provenance !== "all" ? filters.provenance : "");
  appendParam(params, "sort", filters.sort !== "recent" ? filters.sort : "");
  appendParam(params, "min_connections", filters.minConnections);
  appendParam(params, "max_connections", filters.maxConnections);
  appendParam(params, "discovered_after", filters.discoveredAfter);
  appendParam(params, "discovered_before", filters.discoveredBefore);
  appendParam(params, "ingested_after", filters.ingestedAfter);
  appendParam(params, "ingested_before", filters.ingestedBefore);
  appendParam(params, "limit", pageSize);
  appendParam(params, "offset", offset);

  const query = params.toString();
  return query ? `/api/pool?${query}` : "/api/pool";
}

// The filters tucked into the "More filters" popover (search, provenance and
// sort have their own always-visible controls).
export const ADVANCED_FILTER_KEYS = [
  "minConnections",
  "maxConnections",
  "discoveredAfter",
  "discoveredBefore",
  "ingestedAfter",
  "ingestedBefore",
];

export function advancedFilterCount(filters = DEFAULT_POOL_FILTERS) {
  return ADVANCED_FILTER_KEYS.filter((key) => filters[key] !== DEFAULT_POOL_FILTERS[key]).length;
}

export function poolFiltersActive(filters = DEFAULT_POOL_FILTERS) {
  return Object.entries(DEFAULT_POOL_FILTERS).some(([key, value]) =>
    key !== "sort" && (key === "labels" ? (filters.labels || []).length > 0 : filters[key] !== value),
  );
}

export function getPoolPageMeta(payload, fallbackCount, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const total = Number.isFinite(Number(payload?.total)) ? Number(payload.total) : fallbackCount;
  const offset = Number.isFinite(Number(payload?.offset)) ? Number(payload.offset) : Math.max(0, page - 1) * pageSize;
  const limit = Number.isFinite(Number(payload?.limit)) ? Number(payload.limit) : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit)));

  return {
    total,
    offset,
    limit,
    page,
    pageCount,
    start: total === 0 ? 0 : offset + 1,
    end: Math.min(total, offset + fallbackCount),
  };
}

function appendParam(params, key, value) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  params.set(key, String(value));
}
