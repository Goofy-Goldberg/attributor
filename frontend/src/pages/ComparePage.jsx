import { FingerprintIcon, GitCompareArrowsIcon, RefreshCwIcon, TableIcon, TriangleAlertIcon, UnplugIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import {
  fetchJson,
  normalizeConnectionPairs,
  normalizeExplorerGraph,
  normalizeGraphLinks,
  normalizeRelatedThrough,
  normalizeRelatedThroughPage,
} from "@/api.js";
import LazyClusterGraph from "@/components/LazyClusterGraph.jsx";
import { EmptyState, ErrorState, LoadingState, PageHeader, Section } from "@/components/page.jsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import DomainPicker from "@/features/DomainPicker.jsx";
import { ConnectionList, ConnectionRow, ScoreHelp, StrengthDot } from "@/features/evidence.jsx";
import ExportMenu from "@/features/ExportMenu.jsx";
import { domainUrl } from "@/lib/routes.js";

const EXPANSION_MAX_DOMAINS = 30;
const RUN_DEBOUNCE_MS = 400;

export function comparisonSelectionKey(selected) {
  return JSON.stringify(selected);
}

export function isCurrentComparisonRequest(request, currentRequest, selectionKey) {
  return Boolean(
    request &&
      currentRequest &&
      request.id === currentRequest.id &&
      request.key === currentRequest.key &&
      request.key === selectionKey,
  );
}

export function comparisonViewState(state, selected) {
  const selectionKey = comparisonSelectionKey(selected);
  const current = state?.key === selectionKey;
  return {
    result: current ? state.result : null,
    relatedChains: current ? state.relatedChains : new Map(),
    seedDomains: current ? state.seedDomains : [],
    busy: current && Boolean(state.busy),
    ready: current && !state.busy && Boolean(state.result),
    error: current ? state.error : null,
    partialWarning: current ? state.partialWarning : null,
    pathCoverage: current ? state.pathCoverage : null,
  };
}

// The API may return the same channel with different casing or a trailing dot
// trimmed. Use this only for comparisons; keep the server's spelling for UI.
function domainKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function pairVerdictKey(a, b) {
  return domainKey(a) < domainKey(b) ? `${domainKey(a)}\u0000${domainKey(b)}` : `${domainKey(b)}\u0000${domainKey(a)}`;
}

export default function ComparePage() {
  const [params, setParams] = useSearchParams();
  const selected = useMemo(() => [...new Set(params.getAll("d").filter(Boolean))], [params]);

  const setSelected = useCallback(
    (next) =>
      setParams((current) => {
        const updated = new URLSearchParams(current);
        updated.delete("d");
        next.forEach((domain) => updated.append("d", domain));
        return updated;
      }),
    [setParams],
  );
  const add = (domain) => !selected.includes(domain) && setSelected([...selected, domain]);
  const remove = (domain) => setSelected(selected.filter((entry) => entry !== domain));

  const { result, relatedChains, seedDomains, busy, ready, error, partialWarning, pathCoverage, run } = useComparison(selected);

  // The comparison follows the selection: adding or removing a channel
  // re-scores, so there is no stale "press the button again" state to notice.
  useEffect(() => {
    if (selected.length === 0) {
      return undefined;
    }
    const handle = window.setTimeout(run, RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [run, selected.length]);

  const [savedVerdicts, setSavedVerdicts] = useState(new Map());
  const pairs = useMemo(
    () =>
      normalizeConnectionPairs(result).map((pair) => ({
        ...pair,
        verdictSummary: savedVerdicts.get(pairVerdictKey(pair.a, pair.b)) || pair.verdictSummary,
      })),
    [result, savedVerdicts],
  );
  const handleVerdictSaved = useCallback(({ a, b, summary }) => {
    setSavedVerdicts((current) => new Map(current).set(pairVerdictKey(a, b), summary));
  }, []);
  const explorerGraph = useMemo(() => normalizeExplorerGraph(result, relatedChains), [result, relatedChains]);
  const seedSet = useMemo(() => new Set(seedDomains), [seedDomains]);
  const scoredDomains = result?.domains || [];
  const expandedCount = scoredDomains.filter((domain) => !seedSet.has(domain)).length;

  const exportScope = useMemo(() => {
    const chains = [];
    relatedChains.forEach((entries, seed) => {
      (entries || [])
        .filter((entry) => entry.hops > 1)
        .forEach((entry) => chains.push({ a: seed, b: entry.target, hops: entry.hops, chain: entry.chain }));
    });
    const poolLinks = result?.pool_links || {};
    const poolMeta = result?.pool_link_meta || {};
    const exportPairs = [...pairs];
    const seenPairs = new Set(pairs.map((pair) => pairVerdictKey(pair.a, pair.b)));
    for (const [domain, links] of Object.entries(poolLinks)) {
      for (const link of normalizeGraphLinks({ links })) {
        if (!link?.target) continue;
        const key = pairVerdictKey(domain, link.target);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        exportPairs.push({ ...link, a: domain, b: link.target, connected: true,
          verdictSummary: savedVerdicts.get(key) || link.verdictSummary });
      }
    }
    const directShown = exportPairs.filter((pair) => pair.connected).length;
    const hasMoreDirect = Object.values(poolMeta).some((meta) => meta.has_more);
    const selectedKeys = new Set(selected.map(domainKey));
    const selectedShown = (result?.domains || []).filter((domain) => selectedKeys.has(domainKey(domain))).length;
    return {
      title: "Channel connection report", domains: result?.domains || selected, pairs: exportPairs, chains,
      coverage: {
        direct: { shown: directShown, total: hasMoreDirect ? null : directShown, hasMore: hasMoreDirect },
        paths: pathCoverage,
        selection: { shown: selectedShown, total: selected.length, truncated: selectedShown < selected.length || Boolean(result?.selection_truncated) },
      },
    };
  }, [result, selected, pairs, relatedChains, pathCoverage, savedVerdicts]);

  return (
    <>
      <PageHeader
        actions={result ? <ExportMenu disabled={!ready} scope={exportScope} /> : null}
        description="Check whether channels share infrastructure or identifiers — with each other and with the rest of the pool."
        title="Compare channels"
      />

      <Card className="py-4">
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {selected.map((domain) => (
              <Badge className="h-7 gap-1 pr-1 pl-2.5 text-sm" key={domain} variant={seedSet.size === 0 || seedSet.has(domain) ? "secondary" : "outline"}>
                <Link className="hover:underline" to={domainUrl(domain)}>
                  {domain}
                </Link>
                <button
                  aria-label={`Remove ${domain}`}
                  className="hover:bg-foreground/10 rounded-full p-0.5"
                  onClick={() => remove(domain)}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
            <DomainPicker label={selected.length === 0 ? "Add a channel" : "Add"} onAdd={add} selected={selected} />
            {selected.length > 0 ? (
              <div className="ml-auto flex items-center gap-1">
                <Button disabled={busy} onClick={run} size="sm" variant="ghost">
                  <RefreshCwIcon className={busy ? "animate-spin" : undefined} data-icon="inline-start" />
                  {busy ? "Scoring…" : "Re-run"}
                </Button>
                <Button onClick={() => setSelected([])} size="sm" variant="ghost">
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
          {selected.length === 1 ? (
            <p className="text-muted-foreground text-sm">
              Showing how <span className="text-foreground font-medium">{selected[0]}</span> links to the rest of the pool.
              Add another channel to test them against each other.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {selected.length === 0 ? (
        <EmptyState
          description="Add channels above, tick several rows in the Channels table, or start from a shared piece of evidence."
          icon={GitCompareArrowsIcon}
          title="Pick channels to compare"
        >
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link to="/">
                <TableIcon data-icon="inline-start" />
                Browse channels
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/evidence">
                <FingerprintIcon data-icon="inline-start" />
                Browse shared evidence
              </Link>
            </Button>
          </div>
        </EmptyState>
      ) : null}

      {error ? <ErrorState message={error} title="Could not score these channels" /> : null}
      {partialWarning ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Partial result</AlertTitle>
          <AlertDescription>{partialWarning}</AlertDescription>
        </Alert>
      ) : null}
      {busy ? <LoadingState message="Scoring connections…" /> : null}

      {result && ready && selected.length > 0 ? (
        <div className="flex flex-col gap-6 transition-opacity">
          <Verdict expandedCount={expandedCount} pairs={pairs} seedSet={seedSet} />
          <Tabs defaultValue={seedDomains.length >= 2 ? "pairs" : "pool"} key={seedDomains.length >= 2 ? "multi" : "single"}>
            <TabsList variant="line">
              {seedDomains.length >= 2 ? <TabsTrigger value="pairs">Pairs</TabsTrigger> : null}
              <TabsTrigger value="map">Network map</TabsTrigger>
              {result.pool_links ? <TabsTrigger value="pool">Links to the rest of the pool</TabsTrigger> : null}
            </TabsList>
            {seedDomains.length >= 2 ? (
              <TabsContent className="pt-4" value="pairs">
                <PairsPanel expandedCount={expandedCount} onVerdictSaved={handleVerdictSaved} pairs={pairs} seedSet={seedSet} />
              </TabsContent>
            ) : null}
            <TabsContent className="pt-4" value="map">
              {explorerGraph.nodes.length > 0 ? (
                <LazyClusterGraph
                  description="Selected channels and the related channels surfaced by shared infrastructure or registration evidence."
                  exportFileName="domain-network"
                  graph={explorerGraph}
                  otherRoleColor="#64748b"
                  otherRoleLabel="Related channel"
                  pinSeeds
                  seedRoleLabel="Selected channel"
                  seedTargets={seedSet}
                  title="Network map"
                />
              ) : (
                <EmptyState description="There are no links to draw between these channels." icon={UnplugIcon} title="Nothing to map" />
              )}
            </TabsContent>
            {result.pool_links ? (
              <TabsContent className="pt-4" value="pool">
                <PoolLinksPanel onVerdictSaved={handleVerdictSaved} poolLinks={result.pool_links} savedVerdicts={savedVerdicts} seedSet={seedSet} />
              </TabsContent>
            ) : null}
          </Tabs>
        </div>
      ) : null}
    </>
  );
}

// The one-line answer to "are these connected?", before any detail.
function Verdict({ pairs, seedSet, expandedCount }) {
  const seedPairs = pairs.filter((pair) => seedSet.has(pair.a) && seedSet.has(pair.b));
  const connected = seedPairs.filter((pair) => pair.connected);
  const strongest = [...connected].sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  if (seedSet.size < 2) {
    return null;
  }

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-lg font-semibold">
            {connected.length === 0
              ? "No direct evidence links these channels"
              : `${connected.length} of ${seedPairs.length} pair${seedPairs.length === 1 ? "" : "s"} share evidence`}
          </span>
          <span className="text-muted-foreground text-sm">
            {strongest ? (
              <>
                Strongest: {strongest.a} ↔ {strongest.b}, match score {Math.round(strongest.score)}.{" "}
              </>
            ) : null}
            {expandedCount > 0
              ? `${expandedCount} related channel${expandedCount === 1 ? " was" : "s were"} pulled in through multi-hop links.`
              : null}
          </span>
        </div>
        {strongest ? (
          <div className="flex items-center gap-2">
            <StrengthDot className="size-3" link={strongest} />
            <span className="text-3xl font-semibold tabular-nums">{Math.round(strongest.score)}</span>
            <ScoreHelp />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PairsPanel({ pairs, seedSet, expandedCount, onVerdictSaved }) {
  const [scope, setScope] = useState("selected");
  const inScope = pairs.filter((pair) => scope === "all" || (seedSet.has(pair.a) && seedSet.has(pair.b)));
  const connected = inScope.filter((pair) => pair.connected).sort((a, b) => (b.score || 0) - (a.score || 0));
  const unconnected = inScope.filter((pair) => !pair.connected);

  return (
    <Section
      actions={
        expandedCount > 0 ? (
          <ToggleGroup onValueChange={(value) => value && setScope(value)} size="sm" type="single" value={scope} variant="outline">
            <ToggleGroupItem value="selected">Selected only</ToggleGroupItem>
            <ToggleGroupItem value="all">Include related</ToggleGroupItem>
          </ToggleGroup>
        ) : null
      }
      description="Open any pair to review its evidence and record an assessment."
      title={`${connected.length} connected pair${connected.length === 1 ? "" : "s"}`}
    >
      {connected.length === 0 ? (
        <EmptyState description="These channels share no attributing evidence with each other." icon={UnplugIcon} title="No connected pairs" />
      ) : (
        <div className="flex flex-col gap-2">
          {connected.map((pair) => (
            <ConnectionRow key={`${pair.a}|${pair.b}`} leftLabel={pair.a} link={pair} onVerdictSaved={onVerdictSaved} rightLabel={pair.b} showPair />
          ))}
        </div>
      )}
      {unconnected.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">No shared evidence ({unconnected.length})</p>
          {unconnected.map((pair) => (
            <ConnectionRow key={`${pair.a}|${pair.b}`} leftLabel={pair.a} link={pair} onVerdictSaved={onVerdictSaved} rightLabel={pair.b} showPair />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function PoolLinksPanel({ poolLinks, seedSet, savedVerdicts, onVerdictSaved }) {
  const entries = Object.entries(poolLinks || {});
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      {entries.map(([domain, rawLinks]) => {
        const links = normalizeGraphLinks({ links: rawLinks }).map((link) => ({
          ...link,
          verdictSummary: savedVerdicts.get(pairVerdictKey(domain, link.target)) || link.verdictSummary,
        }));
        return (
          <Section
            description={links.length === 0 ? "No attributing connections to the wider pool." : "Its strongest links across the whole pool."}
            key={domain}
            title={
              <Link className="hover:underline" to={domainUrl(domain)}>
                {domain}
              </Link>
            }
          >
            {links.length > 0 ? (
              <div className="flex flex-col gap-2">
                <ConnectionList
                  foldInfrastructure={(link) => !seedSet.has(link.target)}
                  leftLabel={domain}
                  links={links.slice(0, 8)}
                  onVerdictSaved={onVerdictSaved}
                />
                {links.length > 8 ? (
                  <Link className="text-muted-foreground text-sm hover:underline" to={domainUrl(domain)}>
                    See all {links.length} on the channel page →
                  </Link>
                ) : null}
              </div>
            ) : null}
          </Section>
        );
      })}
    </div>
  );
}

// Scores the selection, first expanding it with each channel's precomputed
// multi-hop neighbourhood so channels reachable only through an intermediary
// are part of the picture.
function useComparison(selected) {
  const selectionKey = comparisonSelectionKey(selected);
  const selectionKeyRef = useRef(selectionKey);
  const requestRef = useRef({ id: 0, key: null, controller: null });
  const [state, setState] = useState(() => ({
    key: selectionKey,
    result: null,
    seedDomains: [],
    relatedChains: new Map(),
    busy: false,
    error: null,
    partialWarning: null,
    pathCoverage: null,
  }));

  // Abort and invalidate the previous request as soon as the selection changes.
  // The id bump matters even when the user returns to a previous selection while
  // an aborted request is still unwinding.
  useLayoutEffect(() => {
    selectionKeyRef.current = selectionKey;
    const previous = requestRef.current;
    previous.controller?.abort();
    requestRef.current = { id: previous.id + 1, key: selectionKey, controller: null };
  }, [selectionKey]);

  useEffect(() => () => requestRef.current.controller?.abort(), []);

  const run = useCallback(async () => {
    if (selected.length < 1 || selectionKeyRef.current !== selectionKey) {
      return;
    }
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const request = { id: requestRef.current.id + 1, key: selectionKey, controller };
    requestRef.current = request;
    const { signal } = controller;
    const isCurrent = () => isCurrentComparisonRequest(request, requestRef.current, selectionKeyRef.current);

    setState({
      key: selectionKey,
      result: null,
      seedDomains: [],
      relatedChains: new Map(),
      busy: true,
      error: null,
      partialWarning: null,
      pathCoverage: null,
    });
    try {
      const seedSet = new Set(selected);
      const relatedLists = await Promise.all(
        selected.map(async (domain) => {
          try {
            const page = normalizeRelatedThroughPage(await fetchJson(`/api/graph/related/${encodeURIComponent(domain)}`, { signal }));
            return { ...page, entries: page.related, failed: false };
          } catch (err) {
            // No precomputed neighbourhood (404) is common and fine; a 500 or
            // timeout is a failure to answer and must be reported, or that
            // channel's multi-hop expansion silently vanishes.
            if (signal.aborted) {
              throw err;
            }
            return { entries: [], total: 0, hasMore: false, partial: false, stale: false, pathLimits: null, failed: err?.status !== 404 };
          }
        }),
      );
      if (!isCurrent()) {
        return;
      }
      const relatedTargets = new Set();
      const chainMap = new Map();
      const failures = [];
      selected.forEach((domain, index) => {
        const { entries, failed } = relatedLists[index];
        if (failed) {
          failures.push(domain);
        }
        chainMap.set(domain, entries);
        entries.forEach((entry) => {
          if (entry.target && !seedSet.has(entry.target)) {
            relatedTargets.add(entry.target);
          }
        });
      });

      const scoredSelections = selected.slice(0, EXPANSION_MAX_DOMAINS);
      const relatedSlots = EXPANSION_MAX_DOMAINS - scoredSelections.length;
      const expanded = [...scoredSelections, ...[...relatedTargets].slice(0, relatedSlots)];
      const selectionWarning =
        selected.length > scoredSelections.length
          ? `Showing ${scoredSelections.length} of ${selected.length} selected channels.`
          : null;
      const expansionWarning =
        relatedTargets.size > relatedSlots
          ? `Showing ${expanded.length - scoredSelections.length} of ${relatedTargets.size} related channels.`
          : null;
      const finalResult = await fetchJson("/api/graph/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: expanded, pool_links: true }),
        signal,
      });
      if (!isCurrent()) {
        return;
      }
      const returnedDomains = Array.isArray(finalResult.domains) ? finalResult.domains : [];
      const serverTruncated = returnedDomains.length < expanded.length;
      // Intersect against the canonical names the backend resolved, since the
      // raw selection may differ in case or have a trailing dot.
      const seedKeys = new Set(selected.flatMap((domain) => {
        const key = domainKey(domain);
        return key ? [key] : [];
      }));
      const resolvedSeeds = returnedDomains.filter((domain) => seedKeys.has(domainKey(domain)));
      const warnings = [];
      if (failures.length > 0) {
        warnings.push(
          `Could not load the multi-hop neighbourhood for ${failures.join(", ")}. Channels reachable only through those are missing from this view.`,
        );
      }
      if (expansionWarning) {
        warnings.push(expansionWarning);
      }
      if (selectionWarning) {
        warnings.push(selectionWarning);
      }
      if (serverTruncated) {
        warnings.push(
          `The server returned ${returnedDomains.length} of ${expanded.length} submitted channels; some names could not be resolved or were limited by the server.`,
        );
      }
      const limitedPaths = relatedLists.filter((page) => page.partial);
      const stalePaths = relatedLists.filter((page) => page.stale);
      if (limitedPaths.length) warnings.push(`Path search reached its limits for ${limitedPaths.length} selected channel(s); other connections may be missing.`);
      if (stalePaths.length) warnings.push(`The path index is waiting for a refresh for ${stalePaths.length} selected channel(s).`);
      const pathCoverage = {
        shown: relatedLists.reduce((count, page) => count + page.entries.length, 0),
        total: relatedLists.reduce((count, page) => count + page.total, 0),
        hasMore: relatedLists.some((page) => page.hasMore),
        partial: limitedPaths.length > 0,
        failed: failures.length > 0,
        stale: stalePaths.length > 0,
        pathLimits: relatedLists.find((page) => page.partial)?.pathLimits || null,
      };
      setState({
        key: selectionKey,
        result: finalResult,
        relatedChains: chainMap,
        seedDomains: resolvedSeeds.length > 0 ? resolvedSeeds : selected,
        busy: true,
        error: null,
        partialWarning: warnings.length > 0 ? warnings.join(" ") : null,
        pathCoverage,
      });
    } catch (err) {
      if (signal.aborted || !isCurrent()) {
        return;
      }
      setState({
        key: selectionKey,
        result: null,
        seedDomains: [],
        relatedChains: new Map(),
        busy: false,
        error: err.message || "Could not load connections.",
        partialWarning: null,
        pathCoverage: null,
      });
    } finally {
      if (isCurrent()) {
        requestRef.current = { ...request, controller: null };
        setState((current) => ({ ...current, busy: false }));
      }
    }
  }, [selected, selectionKey]);

  return { ...comparisonViewState(state, selected), run };
}
