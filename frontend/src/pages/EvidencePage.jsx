import { ArrowRightIcon, FingerprintIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import { formatNumber, normalizeSelectorGroups, normalizeSelectorKinds, useApi } from "@/api.js";
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/page.jsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CopyValue, FaviconThumb, sharedNodeLabel } from "@/features/evidence.jsx";
import { compareUrl, domainUrl } from "@/lib/routes.js";
import { cn } from "@/lib/utils";

const ALL = "__all__";
const VISIBLE_DOMAINS = 10;

// Browse the pool by the evidence that links it: every cert, IP, tracking ID…
// shared by more than one channel, with the channels that share it.
export default function EvidencePage() {
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") || "";
  const kindsRequest = useApi("/api/graph/selector-kinds");
  const kinds = useMemo(() => normalizeSelectorKinds(kindsRequest.data), [kindsRequest.data]);
  const groupsRequest = useApi(kind ? `/api/graph/by-selector?kind=${encodeURIComponent(kind)}` : "/api/graph/by-selector");
  const groups = useMemo(() => normalizeSelectorGroups(groupsRequest.data), [groupsRequest.data]);

  const setKind = (next) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next && next !== ALL) {
          updated.set("kind", next);
        } else {
          updated.delete("kind");
        }
        return updated;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader
        actions={
          <Button aria-label="Refresh" onClick={groupsRequest.refresh} size="icon" title="Refresh" variant="ghost">
            <RefreshCwIcon className={cn(groupsRequest.loading && "animate-spin")} />
          </Button>
        }
        description="Every certificate, IP, tracking ID or other value shared by more than one channel — the raw material of every connection."
        title="Shared evidence"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select onValueChange={setKind} value={kind || ALL}>
          <SelectTrigger aria-label="Evidence type" className="w-72">
            <SelectValue placeholder="All evidence types" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All evidence types</SelectItem>
              {kinds.map((entry) => (
                <SelectItem key={entry.kind} value={entry.kind}>
                  {sharedNodeLabel(entry.kind)}
                  {entry.groups !== null ? <span className="text-muted-foreground ml-auto tabular-nums">{formatNumber(entry.groups)}</span> : null}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {groupsRequest.data ? (
          <span className="text-muted-foreground text-sm">
            {formatNumber(groups.length)} shared value{groups.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {kindsRequest.error ? <ErrorState message={kindsRequest.error} title="Could not load evidence types" /> : null}
      {groupsRequest.error ? <ErrorState message={groupsRequest.error} title="Could not load shared evidence" /> : null}
      {groupsRequest.loading && !groupsRequest.data ? <SkeletonRows rows={6} /> : null}
      {groupsRequest.data && groups.length === 0 ? (
        <EmptyState
          description="Nothing of this type is shared by more than one channel yet."
          icon={FingerprintIcon}
          title="No shared evidence"
        />
      ) : null}

      {groups.length > 0 ? (
        <div className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3", groupsRequest.loading && "opacity-60")}>
          {groups.map((group) => (
            <Card className="gap-3 py-4" key={group.id}>
              <CardHeader className="px-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-muted-foreground text-xs">{sharedNodeLabel(group.kind)}</span>
                    <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                      <FaviconThumb kind={group.kind} value={group.value} />
                      <CopyValue value={group.value} />
                    </CardTitle>
                  </div>
                  <Badge className="shrink-0 tabular-nums" title="Channels sharing this value">
                    {group.degree ?? group.domains.length}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1 px-4">
                {group.domains.slice(0, VISIBLE_DOMAINS).map((domain) => (
                  <Badge asChild key={`${group.id}-${domain}`} variant="outline">
                    <Link to={domainUrl(domain)}>{domain}</Link>
                  </Badge>
                ))}
                {group.domains.length > VISIBLE_DOMAINS ? (
                  <Badge variant="ghost">+{group.domains.length - VISIBLE_DOMAINS} more</Badge>
                ) : null}
              </CardContent>
              <CardFooter className="mt-auto px-4">
                <Button asChild className="w-full" size="sm" variant="secondary">
                  <Link to={compareUrl(group.domains)}>
                    Compare {group.domains.length === 2 ? "both" : `all ${group.domains.length}`}
                    <ArrowRightIcon data-icon="inline-end" />
                  </Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : null}
    </>
  );
}
