import { ChevronDownIcon, GitCompareArrowsIcon, LinkIcon, RouteIcon, SearchIcon, UnplugIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import {
  formatDate,
  formatLabel,
  formatNumber,
  normalizeGraphLinkPage,
  normalizeGraphPath,
  normalizeRelatedThroughPage,
  useApi,
} from "@/api.js";
import { EmptyState, ErrorState, LoadingState, Section, SkeletonRows, Stat } from "@/components/page.jsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ConnectionList,
  CopyValue,
  FaviconThumb,
  ProvenanceBadge,
  ScoreHelp,
  TierBadge,
  ipNetworkBadge,
  sharedNodeLabel,
} from "@/features/evidence.jsx";
import ExportMenu from "@/features/ExportMenu.jsx";
import { PathChain } from "@/features/pathExplain.jsx";
import { compareUrl, domainUrl } from "@/lib/routes.js";
import { cn } from "@/lib/utils";

const INITIAL_CONNECTIONS = 25;
const TABS = ["connections", "evidence", "intel", "hosts"];

function pairVerdictKey(a, b) {
  return String(a) < String(b) ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export default function DomainPage() {
  const { value } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "connections";
  const profileRequest = useApi(`/api/domain/${encodeURIComponent(value)}`);
  const linksRequest = useApi(`/api/graph/links/${encodeURIComponent(value)}`);
  const profile = profileRequest.data;
  const [savedVerdicts, setSavedVerdicts] = useState(new Map());
  const linksPage = useMemo(() => normalizeGraphLinkPage(linksRequest.data), [linksRequest.data]);
  const links = useMemo(
    () =>
      linksPage.links.map((link) => ({
        ...link,
        verdictSummary: savedVerdicts.get(pairVerdictKey(value, link.target)) || link.verdictSummary,
      })),
    [linksPage, savedVerdicts, value],
  );
  const handleVerdictSaved = useCallback(({ a, b, summary }) => {
    setSavedVerdicts((current) => new Map(current).set(pairVerdictKey(a, b), summary));
  }, []);
  const intel = profile?.intel || null;
  const otherHosts = (profile?.hosts || []).filter((host) => host.value !== profile?.domain);
  const selectorCount = (profile?.selectors || []).length;
  const sharedSelectorCount = (profile?.selectors || []).filter((selector) => selector.degree > 1).length;
  const directTargets = useMemo(() => new Set(links.map((link) => link.target)), [links]);

  const exportScope = useMemo(
    () => ({
      title: `${value} — connection report`,
      domains: [value],
      pairs: links.map((link) => ({ ...link, a: value, b: link.target, connected: true })),
      chains: [],
      coverage: { direct: { shown: links.length, total: linksPage.total, hasMore: linksPage.hasMore } },
    }),
    [value, links, linksPage],
  );

  const setTab = (next) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === "connections") {
          updated.delete("tab");
        } else {
          updated.set("tab", next);
        }
        return updated;
      },
      { replace: true },
    );

  return (
    <>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight break-all">{value}</h1>
            {profile ? <ProvenanceBadge ingested={profile.ingested} /> : null}
            {profile?.tier ? <TierBadge tier={profile.tier} /> : null}
            {(profile?.labels || []).map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}
          </div>
          {profile && !profile.ingested && intel?.discovery_kind ? (
            <p className="text-muted-foreground text-sm">
              Found via {formatLabel(intel.discovery_kind)}
              {intel.discovered_from ? (
                <>
                  {" from "}
                  <Link className="text-foreground underline-offset-4 hover:underline" to={domainUrl(intel.discovered_from)}>
                    {intel.discovered_from}
                  </Link>
                </>
              ) : null}
              {intel.discovery_reason ? ` (${intel.discovery_reason})` : ""}.
            </p>
          ) : null}
          {(intel?.opencti_labels || []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {intel.opencti_labels.map((label) => (
                <Badge key={label} title="OpenCTI label" variant="outline">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <ExportMenu disabled={links.length === 0} scope={exportScope} />
          <Button asChild>
            <Link to={compareUrl([value])}>
              <GitCompareArrowsIcon data-icon="inline-start" />
              Compare with others
            </Link>
          </Button>
        </div>
      </div>

      {profileRequest.error ? <ErrorState message={profileRequest.error} title="Could not load this channel" /> : null}

      {profileRequest.loading && !profile ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-20 w-full" />
          <SkeletonRows rows={6} />
        </div>
      ) : null}

      {profile ? (
        <>
          <Card className="py-4">
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Connections" value={linksRequest.data ? formatNumber(linksPage.total) : "…"} />
              <Stat label="Hosts" value={formatNumber(profile.host_count || 0)} />
              <Stat label="IP addresses" value={formatNumber((profile.ips || []).length)} />
              <Stat label="Last scan" value={intel?.timestamp ? new Date(intel.timestamp).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—"} />
            </CardContent>
          </Card>

          <Tabs onValueChange={setTab} value={tab}>
            <TabsList className="h-auto flex-wrap justify-start" variant="line">
              <TabsTrigger value="connections">
                Connections <CountBadge value={linksPage.total} />
              </TabsTrigger>
              <TabsTrigger value="evidence">
                Extracted evidence <CountBadge value={selectorCount} />
              </TabsTrigger>
              <TabsTrigger value="intel">Scan details</TabsTrigger>
              <TabsTrigger value="hosts">
                Hosts <CountBadge value={otherHosts.length} />
              </TabsTrigger>
            </TabsList>

            <TabsContent className="flex flex-col gap-8 pt-4" value="connections">
              <DirectConnections hasMore={linksPage.hasMore} links={links} onVerdictSaved={handleVerdictSaved} request={linksRequest} total={linksPage.total} value={value} />
              <RelatedThroughSection directTargets={directTargets} value={value} />
              <FindPathSection value={value} />
            </TabsContent>

            <TabsContent className="pt-4" value="evidence">
              <SelectorsSection selectors={profile.selectors || []} sharedCount={sharedSelectorCount} />
            </TabsContent>

            <TabsContent className="pt-4" value="intel">
              <IntelSection intel={intel} ips={profile.ips || []} />
            </TabsContent>

            <TabsContent className="pt-4" value="hosts">
              <HostsSection hosts={otherHosts} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </>
  );
}

function CountBadge({ value }) {
  if (!value) {
    return null;
  }
  return (
    <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums" variant="secondary">
      {value}
    </Badge>
  );
}

function DirectConnections({ value, links, onVerdictSaved, request, total, hasMore }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? links : links.slice(0, INITIAL_CONNECTIONS);

  return (
    <Section
      description={
        <span className="inline-flex items-center gap-1">
          Channels sharing attributing evidence with {value}, strongest first. <ScoreHelp />
        </span>
      }
      title="Direct connections"
    >
      {request.error ? <ErrorState message={request.error} title="Could not load connections" /> : null}
      {request.loading && !request.data ? <SkeletonRows rows={4} /> : null}
      {request.data && links.length === 0 ? (
        <EmptyState
          description="Nothing in the pool shares attributing evidence with this channel yet."
          icon={UnplugIcon}
          title="No direct connections"
        />
      ) : null}
      {visible.length > 0 ? (
        <div className="flex flex-col gap-2">
          <ConnectionList foldInfrastructure leftLabel={value} links={visible} onVerdictSaved={onVerdictSaved} />
          {/* Never truncate silently: 25 connections and 250 look the same
              otherwise. */}
          {links.length > INITIAL_CONNECTIONS ? (
            <Button className="self-center" onClick={() => setShowAll((current) => !current)} variant="outline">
              {showAll ? "Show the strongest 25" : `Show all ${links.length} loaded connections`}
            </Button>
          ) : null}
          {hasMore ? <p className="text-muted-foreground text-sm">Showing {links.length} of {total} direct connections.</p> : null}
        </div>
      ) : null}
    </Section>
  );
}

// A channel's precomputed multi-hop neighbourhood (db.intel_db.graph_paths) —
// domains reachable only through an intermediary, not shared directly. Always
// an instant indexed read, never a traversal triggered by opening this page.
const RELATED_THROUGH_SECTION_PROPS = {
  description: "No direct evidence, but reachable through an intermediary channel. Precomputed, not a guess.",
  title: "Indirect connections",
};

export function RelatedThroughSection({ value, directTargets }) {
  const relatedRequest = useApi(`/api/graph/related/${encodeURIComponent(value)}?min_hops=2`);
  const relatedPage = useMemo(() => normalizeRelatedThroughPage(relatedRequest.data), [relatedRequest.data]);
  const related = useMemo(
    () => relatedPage.related.filter((entry) => entry.hops > 1 && !directTargets.has(entry.target)),
    [relatedPage, directTargets],
  );

  const hasData = relatedRequest.data !== null && relatedRequest.data !== undefined;
  if (relatedRequest.error) {
    return (
      <Section {...RELATED_THROUGH_SECTION_PROPS}>
        <ErrorState message={relatedRequest.error} title="Could not load indirect connections" />
      </Section>
    );
  }

  if (relatedRequest.loading && !hasData) {
    return (
      <Section {...RELATED_THROUGH_SECTION_PROPS}>
        <SkeletonRows rows={3} />
      </Section>
    );
  }

  if (hasData && related.length === 0) {
    return (
      <Section {...RELATED_THROUGH_SECTION_PROPS}>
        <EmptyState
          description={relatedPage.hasMore
            ? "No indirect connection appears on this page. More precomputed paths are available."
            : relatedPage.partial || relatedPage.stale
              ? "No indirect connection appears in the available paths. The path search was limited or is waiting for a refresh."
              : "No precomputed multi-hop paths remain after direct connections are removed."}
          icon={RouteIcon}
          title={relatedPage.hasMore || relatedPage.partial || relatedPage.stale ? "No path in current results" : "No indirect connections"}
        />
      </Section>
    );
  }

  if (!hasData) {
    return null;
  }

  return (
    <Section {...RELATED_THROUGH_SECTION_PROPS}>
      <div className="flex flex-col gap-2">
        {relatedPage.partial || relatedPage.stale ? (
          <p className="text-muted-foreground text-sm">These paths may be incomplete{relatedPage.stale ? " until the path index refreshes" : " because the search reached its limits"}.</p>
        ) : null}
        {related.slice(0, 20).map((entry) => (
          <Collapsible className="bg-card rounded-lg border" key={entry.target}>
            <CollapsibleTrigger asChild>
              <button className="group hover:bg-muted/60 flex w-full items-center gap-3 rounded-lg p-3 text-left" type="button">
                <RouteIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.target}</span>
                <Badge variant="outline">
                  {entry.hops} hops
                </Badge>
                <span className="text-muted-foreground hidden truncate text-xs sm:inline">
                  via {entry.chain.slice(0, -1).map((hop) => hop.to).join(" → ")}
                </span>
                <ChevronDownIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t p-3">
                <PathChain chain={entry.chain} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
        {related.length > 20 || relatedPage.hasMore ? (
          <p className="text-muted-foreground text-xs">Showing {Math.min(20, related.length)} of {relatedPage.total} available indirect connections.</p>
        ) : null}
      </div>
    </Section>
  );
}

// Precomputed lookup (db.intel_db.path_between / graph_paths) for a specific
// second channel — an indexed read, not a live traversal.
function FindPathSection({ value }) {
  const [input, setInput] = useState("");
  const [target, setTarget] = useState(null);
  const pathRequest = useApi(
    target ? `/api/graph/path?a=${encodeURIComponent(value)}&b=${encodeURIComponent(target)}` : null,
  );
  const path = useMemo(() => normalizeGraphPath(pathRequest.data), [pathRequest.data]);
  // Only a 404 — or a successful lookup that came back empty — means "these
  // two are not connected". A 500 or a dropped connection is a failure to
  // answer, and reporting it as an analytic negative would be false.
  const notConnected =
    target && ((pathRequest.error && pathRequest.status === 404) || (!pathRequest.error && !pathRequest.loading && pathRequest.data && path.chain.length === 0));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LinkIcon className="size-4" />
          Is {value} linked to a specific channel?
        </CardTitle>
        <CardDescription>Look up the hop-by-hop path to another channel in the pool.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim()) {
              setTarget(input.trim());
            }
          }}
        >
          <Field className="flex-1">
            <FieldLabel className="sr-only" htmlFor="find-path-target">
              Other channel
            </FieldLabel>
            <Input
              id="find-path-target"
              onChange={(event) => setInput(event.target.value)}
              placeholder="other-domain.com"
              value={input}
            />
          </Field>
          <Button disabled={!input.trim()} type="submit" variant="secondary">
            <SearchIcon data-icon="inline-start" />
            Find path
          </Button>
        </form>
        {target && pathRequest.loading && !pathRequest.data ? <LoadingState message="Looking up the precomputed path…" /> : null}
        {notConnected ? (
          <p className="text-muted-foreground text-sm">
            No precomputed path between <span className="text-foreground font-medium">{value}</span> and{" "}
            <span className="text-foreground font-medium">{target}</span> within the configured hop limit.
          </p>
        ) : null}
        {target && pathRequest.error && pathRequest.status !== 404 ? (
          <ErrorState message={pathRequest.error} title="Could not look up the path" />
        ) : null}
        {path.chain.length > 0 ? <PathChain chain={path.chain} /> : null}
      </CardContent>
    </Card>
  );
}

function SelectorsSection({ selectors, sharedCount }) {
  const [onlyShared, setOnlyShared] = useState(false);
  const groups = useMemo(() => {
    const map = new Map();
    selectors
      .filter((selector) => !onlyShared || selector.degree > 1)
      .forEach((selector) => {
        if (!map.has(selector.kind)) {
          map.set(selector.kind, []);
        }
        map.get(selector.kind).push(selector);
      });
    // Shared values first within each kind: those are the ones that link.
    return [...map.entries()].map(([kind, items]) => [kind, [...items].sort((a, b) => (b.degree || 0) - (a.degree || 0))]);
  }, [selectors, onlyShared]);

  if (selectors.length === 0) {
    return <EmptyState description="The scan did not extract any observables for this channel." title="No evidence extracted" />;
  }

  return (
    <Section
      actions={
        sharedCount > 0 ? (
          <Button onClick={() => setOnlyShared((current) => !current)} size="sm" variant={onlyShared ? "secondary" : "outline"}>
            {onlyShared ? "Showing shared only" : `Only shared (${sharedCount})`}
          </Button>
        ) : null
      }
      description="Observables pulled from the latest scans. Values shared with other channels are highlighted — those are what create connections."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map(([kind, items]) => (
          <Card className="gap-3 py-4" key={kind}>
            <CardHeader className="px-4">
              <CardTitle className="flex items-center justify-between text-sm">
                {sharedNodeLabel(kind)}
                <span className="text-muted-foreground font-normal tabular-nums">{items.length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 px-4">
              {items.slice(0, 12).map((selector) => (
                <div className="flex min-w-0 items-center gap-2" key={selector.value}>
                  <FaviconThumb kind={kind} value={selector.value} />
                  <CopyValue className="flex-1" value={selector.value} />
                  {selector.degree > 1 ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge className="shrink-0 tabular-nums">{selector.degree}</Badge>
                      </TooltipTrigger>
                      <TooltipContent>Shared by {selector.degree} entities</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              ))}
              {items.length > 12 ? <span className="text-muted-foreground text-xs">+{items.length - 12} more</span> : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function IntelSection({ intel, ips }) {
  const nonEmpty = ([, item]) => item && (!Array.isArray(item) || item.length);
  const dnsEntries = Object.entries(intel?.dns || {}).filter(nonEmpty);
  const whoisEntries = Object.entries(intel?.whois || {}).filter(([key, item]) => item && key !== "error" && key !== "raw");
  const trackingEntries = Object.entries(intel?.tracking || {}).filter(nonEmpty);
  const socialEntries = [
    ...Object.entries(intel?.site_verifications || {}).filter(nonEmpty).map(([key, item]) => [`${formatLabel(key)} verification`, item]),
    ...Object.entries(intel?.social_handles || {}).filter(nonEmpty).map(([key, item]) => [formatLabel(key), item]),
    ...Object.entries(intel?.social_links || {}).filter(nonEmpty).map(([key, item]) => [`${formatLabel(key)} link`, item]),
  ];
  const walletEntries = Object.entries(intel?.crypto_wallets || {}).filter(nonEmpty);
  const phoneNumbers = (intel?.phone_numbers || []).filter(Boolean);
  const certs = intel?.tls_certs || [];

  if (!intel && ips.length === 0) {
    return <EmptyState description="No raw scan is stored for this channel yet." title="No scan details" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {intel?.timestamp ? <p className="text-muted-foreground text-sm">From the latest scan, {formatDate(intel.timestamp)}.</p> : null}

      {ips.length > 0 ? (
        <IntelCard title={`IP addresses (${ips.length})`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IP</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead className="hidden md:table-cell">Operator</TableHead>
                  <TableHead className="text-right">Shared with</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ips.map((entry) => {
                  const badge = ipNetworkBadge(entry.network);
                  return (
                    <TableRow key={entry.ip}>
                      <TableCell className="font-mono text-xs">{entry.ip}</TableCell>
                      <TableCell>{badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-muted-foreground hidden max-w-80 truncate text-xs md:table-cell">
                        {[entry.asn_desc, entry.network_name, entry.proxy_family, entry.country].filter(Boolean).join(" · ") || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entry.degree > 1 ? `${entry.degree - 1} other${entry.degree === 2 ? "" : "s"}` : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </IntelCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {dnsEntries.length > 0 ? <DefinitionCard entries={dnsEntries.map(([key, item]) => [key.toUpperCase(), item])} title="DNS" /> : null}
        {whoisEntries.length > 0 ? <DefinitionCard entries={whoisEntries.map(([key, item]) => [formatLabel(key), item])} title="WHOIS" /> : null}
        {trackingEntries.length > 0 ? (
          <DefinitionCard entries={trackingEntries.map(([key, item]) => [formatLabel(key), item])} mono title="Tracking and analytics" />
        ) : null}
        {socialEntries.length > 0 ? <DefinitionCard entries={socialEntries} title="Social and verification" /> : null}
        {/* Wallet addresses and phone numbers are deliberately inert text — no
            block-explorer or tel: links, since an outbound request would
            disclose the analyst's interest in this target to a third party. */}
        {phoneNumbers.length > 0 || walletEntries.length > 0 ? (
          <DefinitionCard
            entries={[
              ...(phoneNumbers.length > 0 ? [["Phone numbers", phoneNumbers]] : []),
              ...walletEntries.map(([chain, addresses]) => [`${formatLabel(chain)} wallet`, addresses]),
            ]}
            mono
            title="Contact and wallets"
          />
        ) : null}
      </div>

      {certs.length > 0 ? (
        <IntelCard title={`TLS certificates (${certs.length})`}>
          <div className="flex flex-col divide-y">
            {certs.map((cert, index) => (
              <div className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0" key={`${cert.sha256}-${index}`}>
                <span className="text-sm font-medium break-all">{cert.cn || cert.ip || `Certificate ${index + 1}`}</span>
                {cert.issuer ? <span className="text-muted-foreground text-xs">Issued by {cert.issuer}</span> : null}
                {cert.sha256 ? <CopyValue display={`sha256 ${String(cert.sha256).slice(0, 24)}…`} value={cert.sha256} /> : null}
                {(cert.sans || []).length > 0 ? (
                  <span className="text-muted-foreground text-xs break-all">SANs: {cert.sans.join(", ")}</span>
                ) : null}
              </div>
            ))}
          </div>
        </IntelCard>
      ) : null}
    </div>
  );
}

function IntelCard({ title, children }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

function DefinitionCard({ title, entries, mono = false }) {
  return (
    <IntelCard title={title}>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(7rem,auto)_1fr]">
        {entries.map(([key, item]) => (
          <div className="contents" key={key}>
            <dt className="text-muted-foreground">{key}</dt>
            <dd className={cn("min-w-0 break-words", mono && "font-mono text-xs")}>{asText(item)}</dd>
          </div>
        ))}
      </dl>
    </IntelCard>
  );
}

function HostsSection({ hosts }) {
  const [filter, setFilter] = useState("");
  const navigate = useNavigate();
  const visible = hosts.filter((host) => host.value.toLowerCase().includes(filter.trim().toLowerCase()));

  if (hosts.length === 0) {
    return <EmptyState description="Nothing beyond the apex domain is on record." title="No subdomains discovered" />;
  }

  return (
    <Section
      actions={
        <Input
          aria-label="Filter hosts"
          className="w-56"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter hosts…"
          type="search"
          value={filter}
        />
      }
      description={`${hosts.length} subdomain${hosts.length === 1 ? "" : "s"} discovered.`}
    >
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Resolved IPs</TableHead>
              <TableHead className="hidden md:table-cell">Found via</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.slice(0, 200).map((host) => (
              <TableRow className="cursor-pointer" key={host.value} onClick={() => navigate(domainUrl(host.value))}>
                <TableCell className="font-medium">{host.value}</TableCell>
                <TableCell>
                  {(host.ips || []).length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {host.ips.map((ip) => (
                        <Badge className="font-mono" key={ip} variant="outline">
                          {ip}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs">No resolved IP on record</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                  {host.discovery_kind ? formatLabel(host.discovery_kind) : "—"}
                  {host.discovered_from ? ` from ${host.discovered_from}` : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {visible.length > 200 ? <FieldDescription>Showing 200 of {visible.length} hosts. Filter to narrow down.</FieldDescription> : null}
    </Section>
  );
}

function asText(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (Array.isArray(value)) {
    return value.map(asText).join(", ");
  }
  if (typeof value === "object") {
    return value.value || value.exchange || value.name || JSON.stringify(value);
  }
  return String(value);
}
