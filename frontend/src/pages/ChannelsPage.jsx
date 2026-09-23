import {
  ArrowDownIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitCompareArrowsIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { formatDate, formatLabel, formatNumber, normalizePool, useApi } from "@/api.js";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/page.jsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProvenanceBadge, TierBadge } from "@/features/evidence.jsx";
import { useJobs } from "@/features/jobs.jsx";
import { useDebouncedValue } from "@/hooks/use-debounced-value.js";
import { compareUrl, domainUrl } from "@/lib/routes.js";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_POOL_FILTERS,
  advancedFilterCount,
  buildPoolQuery,
  filtersFromParams,
  getPoolPageMeta,
  pageFromParams,
  poolFiltersActive,
  writeFilterParams,
} from "@/utils/poolQuery.js";

// Long enough to collapse a burst of typing into one request, short enough
// that the table still feels live.
const FILTER_DEBOUNCE_MS = 250;

export default function ChannelsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { setSheetOpen, onPoolChanged } = useJobs();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const page = pageFromParams(params);
  // Selection survives paging and filtering on purpose: analysts collect
  // candidates across several views before comparing them.
  const [selected, setSelected] = useState(() => new Set());

  // Typed fields go through a debounce so each keystroke does not issue its
  // own /api/pool query; toggles, sort and paging apply immediately.
  const search = useDebouncedValue(filters.search, FILTER_DEBOUNCE_MS);
  const minConnections = useDebouncedValue(filters.minConnections, FILTER_DEBOUNCE_MS);
  const maxConnections = useDebouncedValue(filters.maxConnections, FILTER_DEBOUNCE_MS);
  const poolPath = buildPoolQuery({ ...filters, search, minConnections, maxConnections }, page, DEFAULT_PAGE_SIZE);
  // The one place a path change means "same resource, narrowed differently",
  // so the previous rows stay on screen while the next page loads.
  const poolRequest = useApi(poolPath, { keepPreviousData: true });
  const domains = useMemo(() => normalizePool(poolRequest.data), [poolRequest.data]);
  const meta = getPoolPageMeta(poolRequest.data, domains.length, page, DEFAULT_PAGE_SIZE);
  const filtersActive = poolFiltersActive(filters);
  const advancedCount = advancedFilterCount(filters);

  useEffect(() => onPoolChanged(() => poolRequest.refresh()), [onPoolChanged, poolRequest.refresh]);

  const update = useCallback(
    (patch, nextPage = 1) => {
      setParams((current) => writeFilterParams(current, { ...filtersFromParams(current), ...patch }, nextPage), {
        replace: true,
      });
    },
    [setParams],
  );
  const setPage = (next) => update({}, next);

  // Filters debounce but paging is immediate, so a page number can briefly
  // overrun the new result's page count. Snap back instead of showing an
  // empty table.
  useEffect(() => {
    if (poolRequest.data && page > meta.pageCount) {
      update({}, meta.pageCount);
    }
  }, [page, meta.pageCount, poolRequest.data, update]);

  const toggle = (domain) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  const pageSelected = domains.length > 0 && domains.every((entry) => selected.has(entry.domain));
  const pagePartlySelected = !pageSelected && domains.some((entry) => selected.has(entry.domain));
  const togglePage = () =>
    setSelected((current) => {
      const next = new Set(current);
      domains.forEach((entry) => (pageSelected ? next.delete(entry.domain) : next.add(entry.domain)));
      return next;
    });

  const poolEmpty = poolRequest.data && meta.total === 0 && !filtersActive;

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/compare">
                <GitCompareArrowsIcon data-icon="inline-start" />
                Compare
              </Link>
            </Button>
            <Button onClick={() => setSheetOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Add channels
            </Button>
          </>
        }
        description={
          poolRequest.data
            ? `${formatNumber(meta.total)} channel${meta.total === 1 ? "" : "s"}${filtersActive ? " match these filters" : " in the pool"}. Select several to check whether they are connected.`
            : "Every submitted or discovered channel, correlated in one shared graph."
        }
        title="Channels"
      />

      {poolEmpty ? (
        <EmptyState description="Add a few domains, links or IPs to start building the correlation graph." title="The pool is empty">
          <Button onClick={() => setSheetOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            Add channels
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-full sm:w-72">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Filter by domain"
                onChange={(event) => update({ search: event.target.value })}
                placeholder="Filter by domain…"
                type="search"
                value={filters.search}
              />
              {filters.search ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton aria-label="Clear search" onClick={() => update({ search: "" })} size="icon-xs">
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>

            <ToggleGroup
              aria-label="Provenance"
              onValueChange={(value) => update({ provenance: value || "all" })}
              type="single"
              value={filters.provenance}
              variant="outline"
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="ingested">Ingested</ToggleGroupItem>
              <ToggleGroupItem value="discovered">Discovered</ToggleGroupItem>
            </ToggleGroup>

            <AdvancedFilters count={advancedCount} filters={filters} update={update} />

            {filtersActive ? (
              <Button
                onClick={() =>
                  setParams((current) => writeFilterParams(current, { ...DEFAULT_POOL_FILTERS, sort: filters.sort }), { replace: true })
                }
                variant="ghost"
              >
                Reset
              </Button>
            ) : null}

            <Button
              aria-label="Refresh"
              className="ml-auto"
              disabled={poolRequest.loading}
              onClick={poolRequest.refresh}
              size="icon"
              title="Refresh"
              variant="ghost"
            >
              <RefreshCwIcon className={cn(poolRequest.loading && "animate-spin")} />
            </Button>
          </div>

          {poolRequest.error ? <ErrorState message={poolRequest.error} title="Could not load the pool" /> : null}

          {poolRequest.loading && !poolRequest.data ? (
            <SkeletonRows rows={8} />
          ) : domains.length === 0 && poolRequest.data ? (
            <EmptyState description="Try widening or resetting the filters." icon={SearchIcon} title="No channels match" />
          ) : domains.length > 0 ? (
            <div className={cn("overflow-hidden rounded-lg border transition-opacity", poolRequest.loading && "opacity-60")}>
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all on this page"
                        checked={pageSelected ? true : pagePartlySelected ? "indeterminate" : false}
                        onCheckedChange={togglePage}
                      />
                    </TableHead>
                    <SortableHead active={filters.sort === "domain"} onClick={() => update({ sort: "domain" }, page)}>
                      Channel
                    </SortableHead>
                    <SortableHead
                      active={filters.sort === "connections"}
                      className="text-right"
                      onClick={() => update({ sort: "connections" }, page)}
                    >
                      Connections
                    </SortableHead>
                    <TableHead className="hidden text-right md:table-cell">Hosts</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Scans</TableHead>
                    <TableHead className="hidden lg:table-cell">Cluster</TableHead>
                    <SortableHead
                      active={filters.sort === "recent"}
                      className="hidden sm:table-cell"
                      onClick={() => update({ sort: "recent" }, page)}
                    >
                      Discovered
                    </SortableHead>
                    <TableHead className="hidden xl:table-cell">Last scan</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map((entry) => (
                    <ChannelRow
                      entry={entry}
                      key={entry.domain}
                      onOpen={() => navigate(domainUrl(entry.domain))}
                      onToggle={() => toggle(entry.domain)}
                      selected={selected.has(entry.domain)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {domains.length > 0 ? (
            <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {formatNumber(meta.start)}–{formatNumber(meta.end)} of {formatNumber(meta.total)}
              </span>
              <div className="flex items-center gap-2">
                <span className="tabular-nums">
                  Page {meta.page} of {meta.pageCount}
                </span>
                <Button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)} size="icon-sm" variant="outline">
                  <ChevronLeftIcon />
                </Button>
                <Button
                  aria-label="Next page"
                  disabled={page >= meta.pageCount}
                  onClick={() => setPage(page + 1)}
                  size="icon-sm"
                  variant="outline"
                >
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {selected.size > 0 ? (
        <div className="bg-popover text-popover-foreground sticky bottom-4 z-10 mx-auto flex w-fit max-w-full items-center gap-3 rounded-full border py-2 pr-2 pl-4 shadow-lg">
          <span className="text-sm whitespace-nowrap">
            <span className="font-semibold tabular-nums">{selected.size}</span> selected
          </span>
          <Button onClick={() => setSelected(new Set())} size="sm" variant="ghost">
            Clear
          </Button>
          <Button className="rounded-full" onClick={() => navigate(compareUrl([...selected]))} size="sm">
            <GitCompareArrowsIcon data-icon="inline-start" />
            {selected.size === 1 ? "Show connections" : `Compare ${selected.size}`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SortableHead({ active, onClick, className, children }) {
  return (
    <TableHead aria-sort={active ? "descending" : undefined} className={className}>
      <button
        className={cn(
          "hover:text-foreground inline-flex items-center gap-1",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={onClick}
        type="button"
      >
        {children}
        <ArrowDownIcon className={cn("size-3", !active && "invisible")} />
      </button>
    </TableHead>
  );
}

function ChannelRow({ entry, selected, onToggle, onOpen }) {
  return (
    <TableRow
      className="cursor-pointer"
      data-state={selected ? "selected" : undefined}
      onClick={(event) => {
        // Checkbox and links handle themselves; the rest of the row opens the
        // channel, which is what an analyst expects a click on a row to do.
        if (event.target.closest("button, a, [role=checkbox]")) {
          return;
        }
        onOpen();
      }}
    >
      <TableCell>
        <Checkbox aria-label={`Select ${entry.domain}`} checked={selected} onCheckedChange={onToggle} />
      </TableCell>
      <TableCell className="max-w-0 min-w-48">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <Link className="truncate font-medium hover:underline" to={domainUrl(entry.domain)}>
              {entry.domain}
            </Link>
            {entry.tier ? <TierBadge tier={entry.tier} /> : null}
            <ProvenanceBadge ingested={entry.ingested} />
          </div>
          {!entry.ingested && entry.discoveryKind ? (
            <span className="text-muted-foreground truncate text-xs">
              via {formatLabel(entry.discoveryKind)}
              {entry.discoveredFrom ? ` from ${entry.discoveredFrom}` : ""}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <span className={cn("font-medium tabular-nums", entry.connectionCount === 0 && "text-muted-foreground font-normal")}>
          {formatNumber(entry.connectionCount)}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-right tabular-nums md:table-cell">{entry.hostCount ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground hidden text-right tabular-nums md:table-cell">{entry.scanCount || "—"}</TableCell>
      <TableCell className="hidden lg:table-cell">
        {entry.clusterId ? (
          <Badge variant="outline">
            {entry.clusterSize} channel{entry.clusterSize === 1 ? "" : "s"}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
        <DateCell value={entry.ingested ? entry.ingestedAt || entry.discoveredAt : entry.discoveredAt} />
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-xs xl:table-cell">
        <DateCell value={entry.lastScannedAt} />
      </TableCell>
      <TableCell>
        <ArrowRightIcon className="text-muted-foreground size-4" />
      </TableCell>
    </TableRow>
  );
}

function DateCell({ value }) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return formatDate(value);
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="whitespace-nowrap">{date.toLocaleDateString(undefined, { dateStyle: "medium" })}</span>
      </TooltipTrigger>
      <TooltipContent>{formatDate(value)}</TooltipContent>
    </Tooltip>
  );
}

function AdvancedFilters({ filters, update, count }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <SlidersHorizontalIcon data-icon="inline-start" />
          More filters
          {count > 0 ? (
            <Badge className="ml-1 h-5 min-w-5 rounded-full px-1 tabular-nums" variant="secondary">
              {count}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>More filters</PopoverTitle>
          <PopoverDescription>Narrow the pool by connection count and dates.</PopoverDescription>
        </PopoverHeader>
        <FieldGroup className="mt-3 gap-4">
          <RangeFields
            fromKey="minConnections"
            fromLabel="At least"
            legend="Connections"
            toKey="maxConnections"
            toLabel="At most"
            type="number"
            {...{ filters, update }}
          />
          <RangeFields
            fromKey="discoveredAfter"
            fromLabel="After"
            legend="Discovered"
            toKey="discoveredBefore"
            toLabel="Before"
            type="date"
            {...{ filters, update }}
          />
          <RangeFields
            fromKey="ingestedAfter"
            fromLabel="After"
            legend="Ingested"
            toKey="ingestedBefore"
            toLabel="Before"
            type="date"
            {...{ filters, update }}
          />
        </FieldGroup>
      </PopoverContent>
    </Popover>
  );
}

function RangeFields({ legend, fromKey, toKey, fromLabel, toLabel, type, filters, update }) {
  const id = legend.toLowerCase();
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel className="text-muted-foreground text-xs font-normal" htmlFor={`${id}-from`}>
            {fromLabel}
          </FieldLabel>
          <Input
            id={`${id}-from`}
            min={type === "number" ? 0 : undefined}
            onChange={(event) => update({ [fromKey]: event.target.value })}
            type={type}
            value={filters[fromKey]}
          />
        </Field>
        <Field>
          <FieldLabel className="text-muted-foreground text-xs font-normal" htmlFor={`${id}-to`}>
            {toLabel}
          </FieldLabel>
          <Input
            id={`${id}-to`}
            min={type === "number" ? 0 : undefined}
            onChange={(event) => update({ [toKey]: event.target.value })}
            type={type}
            value={filters[toKey]}
          />
        </Field>
      </div>
    </FieldSet>
  );
}
