import { ArrowRightIcon, MoreHorizontalIcon, NetworkIcon, RefreshCwIcon, WaypointsIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { fetchJson, normalizeConnectionsGraph, normalizeGraphClusters, useApi } from "@/api.js";
import LazyClusterGraph from "@/components/LazyClusterGraph.jsx";
import { EmptyState, ErrorState, LoadingState, PageHeader, SkeletonRows } from "@/components/page.jsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { FaviconThumb, sharedNodeLabel } from "@/features/evidence.jsx";
import { authClient } from "@/lib/auth-client.js";
import { compareUrl, domainUrl } from "@/lib/routes.js";
import { cn } from "@/lib/utils";

const VISIBLE_MEMBERS = 10;
const VISIBLE_LINKS = 4;

export default function ClustersPage() {
  const session = authClient.useSession();
  const isAdmin = session.data?.user?.role === "admin";
  const clustersRequest = useApi("/api/graph/clusters");
  const clusters = useMemo(() => normalizeGraphClusters(clustersRequest.data), [clustersRequest.data]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const recompute = async () => {
    setRecomputing(true);
    const pending = toast.loading("Rebuilding the correlation graph…", { description: "This can take several minutes." });
    try {
      // Long-running, so it gets a longer ceiling than the default timeout.
      const payload = await fetchJson("/api/graph/recompute", { method: "POST", timeoutMs: 10 * 60 * 1000 });
      toast.success("Graph rebuilt", {
        id: pending,
        description: `${payload?.clusters ?? 0} clusters, ${payload?.entities ?? "?"} entities.`,
      });
      clustersRequest.refresh();
    } catch (err) {
      toast.error("Rebuild failed", { id: pending, description: err.message || "Recompute failed." });
    } finally {
      setRecomputing(false);
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button aria-label="Refresh" onClick={clustersRequest.refresh} size="icon" title="Refresh" variant="ghost">
              <RefreshCwIcon className={cn(clustersRequest.loading && "animate-spin")} />
            </Button>
            {isAdmin ? <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="More actions" size="icon" variant="outline">
                  {recomputing ? <Spinner /> : <MoreHorizontalIcon />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={recomputing} onSelect={() => setConfirmOpen(true)}>
                    <WaypointsIcon />
                    Rebuild correlation graph…
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu> : null}
          </>
        }
        description={
          clustersRequest.data
            ? `${clusters.length} group${clusters.length === 1 ? "" : "s"} of channels linked, directly or through each other, by shared infrastructure or identifiers.`
            : "Groups of channels linked by shared infrastructure or identifiers."
        }
        title="Clusters"
      />

      {isAdmin ? <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild the correlation graph?</AlertDialogTitle>
            <AlertDialogDescription>
              This recomputes every entity, edge and cluster from stored intel. It is normally done automatically in the
              background, can take several minutes, and puts load on the database while it runs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={recompute}>Rebuild</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog> : null}

      {clustersRequest.error ? <ErrorState message={clustersRequest.error} title="Could not load clusters" /> : null}
      {clustersRequest.loading && !clustersRequest.data ? <SkeletonRows rows={6} /> : null}
      {clustersRequest.data && clusters.length === 0 ? (
        <EmptyState
          description="Clusters build automatically in the background as channels are ingested and linked."
          icon={NetworkIcon}
          title="No clusters yet"
        />
      ) : null}

      {clusters.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {clusters.map((cluster) => (
            <ClusterCard cluster={cluster} key={cluster.id} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ClusterCard({ cluster }) {
  const [open, setOpen] = useState(false);
  const [graphState, setGraphState] = useState({ loading: false, error: null, data: null });
  const abortRef = useRef(null);

  const loadGraph = useCallback(async () => {
    // Abortable and unmount-safe: this is a live scoring call.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGraphState({ loading: true, error: null, data: null });
    try {
      const payload = await fetchJson("/api/graph/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: cluster.members, pool_links: false }),
        signal: controller.signal,
      });
      setGraphState({ loading: false, error: null, data: payload });
    } catch (err) {
      if (!controller.signal.aborted) {
        setGraphState({ loading: false, error: err.message || "Could not load the network graph.", data: null });
      }
    }
  }, [cluster.members]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const openGraph = () => {
    setOpen(true);
    if (!graphState.data && !graphState.loading) {
      loadGraph();
    }
  };

  const graph = useMemo(
    () => (graphState.data ? normalizeConnectionsGraph(graphState.data, graphState.data?.domains || cluster.members) : null),
    [graphState.data, cluster.members],
  );
  const seedTargets = useMemo(() => new Set(cluster.members), [cluster.members]);
  const scoredDomains = graphState.data?.domains;
  const truncated = Array.isArray(scoredDomains) && scoredDomains.length < cluster.members.length;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{cluster.members[0] ? `${cluster.members[0]} and others` : `Cluster ${cluster.id}`}</span>
          <Badge className="shrink-0 tabular-nums">{cluster.size} channels</Badge>
        </CardTitle>
        <CardDescription className="font-mono text-xs">#{cluster.id}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex flex-wrap gap-1">
          {cluster.members.slice(0, VISIBLE_MEMBERS).map((member) => (
            <Badge asChild key={member} variant="outline">
              <Link to={domainUrl(member)}>{member}</Link>
            </Badge>
          ))}
          {cluster.members.length > VISIBLE_MEMBERS ? (
            <Badge variant="ghost">+{cluster.members.length - VISIBLE_MEMBERS} more</Badge>
          ) : null}
        </div>
        {cluster.links.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Held together by</span>
            <ul className="flex flex-col gap-1">
              {cluster.links.slice(0, VISIBLE_LINKS).map((link) => (
                <li className="flex min-w-0 items-center gap-2 text-xs" key={`${link.kind}-${link.value}`}>
                  <FaviconThumb kind={link.kind} value={link.value} />
                  <span className="text-muted-foreground shrink-0">{sharedNodeLabel(link.kind)}</span>
                  <span className="truncate font-mono" title={link.value}>
                    {link.value}
                  </span>
                  {link.memberCount ? <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">×{link.memberCount}</span> : null}
                </li>
              ))}
            </ul>
            {cluster.linkCount > VISIBLE_LINKS ? (
              <span className="text-muted-foreground text-xs">+{cluster.linkCount - VISIBLE_LINKS} more shared values</span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="mt-auto gap-2 px-4">
        <Button className="flex-1" onClick={openGraph} size="sm" variant="outline">
          <NetworkIcon data-icon="inline-start" />
          Map
        </Button>
        <Button asChild className="flex-1" size="sm" variant="secondary">
          <Link to={compareUrl(cluster.members)}>
            Compare
            <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      </CardFooter>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[min(1400px,95vw)]">
          <DialogHeader>
            <DialogTitle>Cluster #{cluster.id}</DialogTitle>
            <DialogDescription>
              {cluster.size} channels
              {truncated ? ` — showing the first ${scoredDomains.length}` : ""}.
            </DialogDescription>
          </DialogHeader>
          {graphState.loading ? <LoadingState message="Scoring connections…" /> : null}
          {graphState.error ? <ErrorState message={graphState.error} title="Could not draw the map" /> : null}
          {graph ? <LazyClusterGraph graph={graph} seedTargets={seedTargets} /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
