import { ArrowRightIcon, ChevronDownIcon, CopyIcon, InfoIcon, SaveIcon } from "lucide-react";
import { memo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { fetchJson, formatDate, formatLabel, formatNumber, normalizeVerdictSummary, useApi } from "@/api.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { domainUrl } from "@/lib/routes.js";
import { cn } from "@/lib/utils";

const STRENGTH_TIERS = {
  strong: { tier: "strong", label: "Strong", dot: "bg-strength-strong" },
  moderate: { tier: "moderate", label: "Moderate", dot: "bg-strength-moderate" },
  weak: { tier: "weak", label: "Weak", dot: "bg-strength-weak" },
};

const SELECTOR_KIND_LABELS = {
  tls_cert_sha256: "TLS certificate fingerprint",
  tls_spki: "TLS public key (SPKI)",
  tls_san: "Certificate SAN",
  shared_ip: "Shared IP address",
  ssh_fp: "SSH host key",
  tracking_id: "Tracking / analytics ID",
  site_verification: "Site verification code",
  social_handle: "Social media handle",
  contact_phone: "Contact phone number",
  contact_email: "Contact email",
  crypto_wallet: "Crypto wallet address",
  legal_registration: "Company registration ID",
  legal_entity: "Legal entity name",
  legal_address: "Registered address",
  legal_text_hash: "Legal page content hash",
  favicon_mmh3: "Favicon fingerprint",
  favicon_md5: "Favicon hash",
  html_hash: "Homepage content hash",
  nameserver: "Nameserver",
  network_cidr: "Network block",
  spf_origin: "Mail sending origin (SPF)",
  asn: "ASN",
};

const IP_NETWORK_BADGES = {
  cdn: { label: "CDN / proxy edge", variant: "outline" },
  pool: { label: "Shared hosting pool", variant: "outline" },
  origin: { label: "Likely origin server", variant: "secondary" },
};

const TIER_CLASSES = {
  1: "bg-tier-1",
  2: "bg-tier-2",
  3: "bg-tier-3",
  4: "bg-tier-4",
  5: "bg-tier-5",
};

const FAVICON_KINDS = new Set(["favicon_mmh3", "favicon_md5"]);
const INFRASTRUCTURE_ONLY_KINDS = new Set(["asn", "network_cidr", "nameserver"]);

// Kinds whose value is encoded "<prefix>|<value>" (provider, platform, chain).
// The backend normally splits this out into `subkind`; deriving it from the
// encoding is the fallback so a wallet never reads as raw "bitcoin|bc1q...".
const PREFIXED_VALUE_KINDS = new Set(["tracking_id", "site_verification", "social_handle", "crypto_wallet"]);

export const SCORE_EXPLAINER =
  "The match score adds up the weight of every piece of shared evidence, discounted for how common and how stale it is. Higher means more and rarer shared evidence — it is not a probability of common ownership.";

export function sharedNodeLabel(kind) {
  return SELECTOR_KIND_LABELS[kind] || formatLabel(kind);
}

export function ipNetworkBadge(network) {
  return IP_NETWORK_BADGES[network] || null;
}

export function linkStrength(link) {
  if (link?.strength && STRENGTH_TIERS[link.strength]) {
    return STRENGTH_TIERS[link.strength];
  }
  const value = link?.score ?? 0;
  if (value >= 65) {
    return STRENGTH_TIERS.strong;
  }
  if (value >= 30) {
    return STRENGTH_TIERS.moderate;
  }
  return STRENGTH_TIERS.weak;
}

// CDN and shared-hosting IPs identify a delivery network, while an origin IP
// can identify a server a small set of domains actually shares. Keep that
// distinction in the folding rule so the latter stays visible beside the
// stronger analyst-facing connections.
function isCommonInfrastructureNode(node) {
  if (node?.kind === "shared_ip") {
    const network = String(node.network || "").toLowerCase();
    return network === "cdn" || network === "pool";
  }
  return INFRASTRUCTURE_ONLY_KINDS.has(node?.kind);
}

// A mixed link stays in the main list: one certificate, identifier, or
// dedicated origin next to infrastructure gives the analyst material evidence
// to inspect. An empty or malformed evidence list is equally kept visible.
export function isInfrastructureOnlyLink(link) {
  const evidence = link?.evidence;
  return Array.isArray(evidence) && evidence.length > 0 && evidence.every(isCommonInfrastructureNode);
}

export function partitionInfrastructureOnlyLinks(links, canFold = () => true) {
  return (links || []).reduce(
    (groups, link) => {
      if (isInfrastructureOnlyLink(link) && canFold(link)) {
        groups.infrastructure.push(link);
      } else {
        groups.visible.push(link);
      }
      return groups;
    },
    { visible: [], infrastructure: [] },
  );
}

// Tier 1-5 is an OpenCTI severity scale, not a UI state, so it keeps its own
// fixed data palette (shared with the graph) rather than a badge variant.
export function TierBadge({ tier, className }) {
  if (!TIER_CLASSES[tier]) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className={cn("border-transparent text-white", TIER_CLASSES[tier], className)}>T{tier}</Badge>
      </TooltipTrigger>
      <TooltipContent>OpenCTI tier {tier} (1 = highest priority)</TooltipContent>
    </Tooltip>
  );
}

export function ProvenanceBadge({ ingested }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={ingested ? "secondary" : "outline"}>{ingested ? "Ingested" : "Discovered"}</Badge>
      </TooltipTrigger>
      <TooltipContent>
        {ingested
          ? "Directly submitted, or a subdomain of it was."
          : "Surfaced by following a scan: subdomain, sibling, or wordlist discovery."}
      </TooltipContent>
    </Tooltip>
  );
}

export function StrengthDot({ link, className }) {
  const strength = linkStrength(link);
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", strength.dot, className)} />;
}

export function StrengthLabel({ link }) {
  const strength = linkStrength(link);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <StrengthDot link={link} />
      {strength.label}
    </span>
  );
}

export function ScoreHelp() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button aria-label="What is the match score?" className="text-muted-foreground hover:text-foreground" type="button">
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{SCORE_EXPLAINER}</TooltipContent>
    </Tooltip>
  );
}

export const FaviconThumb = memo(function FaviconThumb({ kind, value }) {
  const [failed, setFailed] = useState(false);
  if (!FAVICON_KINDS.has(kind) || !value || failed) {
    return null;
  }
  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-sm"
      loading="lazy"
      onError={() => setFailed(true)}
      src={`/api/favicon/${encodeURIComponent(kind)}/${encodeURIComponent(value)}`}
    />
  );
});

export function CopyValue({ value, display, className }) {
  const copy = async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(value));
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy — select the text instead.");
    }
  };
  return (
    <span className={cn("group/copy inline-flex max-w-full min-w-0 items-center gap-1", className)}>
      <span className="truncate font-mono text-xs" title={String(value)}>
        {display ?? value}
      </span>
      <Button
        aria-label="Copy value"
        className="opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100"
        onClick={copy}
        size="icon-xs"
        variant="ghost"
      >
        <CopyIcon />
      </Button>
    </span>
  );
}

function sharedNodeDisplay(node) {
  const separator = String(node.value).indexOf("|");
  const subkind =
    node.subkind || (PREFIXED_VALUE_KINDS.has(node.kind) && separator > 0 ? node.value.slice(0, separator) : null);
  const label = subkind ? `${sharedNodeLabel(node.kind)} · ${formatLabel(subkind)}` : sharedNodeLabel(node.kind);
  const prefix = subkind ? `${subkind}|` : null;
  const value = prefix && node.value.startsWith(prefix) ? node.value.slice(prefix.length) : node.value;
  return { label, value };
}

function extraHosts(label, hosts) {
  return (hosts || []).filter((host) => host && host !== label);
}

function formatWindow(range) {
  const [first, last] = range || [];
  if (!first && !last) {
    return "window unknown";
  }
  if (first && last && first !== last) {
    return `${formatDate(first)} → ${formatDate(last)}`;
  }
  return formatDate(first || last);
}

function present(value) {
  return value !== null && value !== undefined;
}

// Client-side "expired/valid" read of a tls_cert_sha256 node's own not_after
// (the CA-issued expiry, not our scan history).
function certExpired(node) {
  if (node.kind !== "tls_cert_sha256" || !node.certNotAfter) {
    return null;
  }
  const notAfter = new Date(node.certNotAfter);
  return Number.isNaN(notAfter.getTime()) ? null : notAfter.getTime() < Date.now();
}

function Metric({ label, value, help }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-help flex-col">
          <dt className="text-muted-foreground text-[11px]">{label}</dt>
          <dd className="text-sm font-medium tabular-nums">{value}</dd>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{help}</TooltipContent>
    </Tooltip>
  );
}

function EvidenceItem({ node, leftLabel, rightLabel }) {
  const network = node.kind === "shared_ip" ? ipNetworkBadge(node.network) : null;
  const { label, value } = sharedNodeDisplay(node);
  const extraA = extraHosts(leftLabel, node.hostsA);
  const extraB = extraHosts(rightLabel, node.hostsB);
  const expired = certExpired(node);
  const context = [node.asnDesc, node.networkName, node.proxyFamily].filter(Boolean);

  return (
    <li className={cn("flex flex-col gap-3 rounded-lg border p-3", node.attributing === false && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            {network ? <Badge variant={network.variant}>{network.label}</Badge> : null}
            {node.attributing === false ? <Badge variant="destructive">Noise</Badge> : null}
            {node.degraded ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge className="text-warning border-warning/40" variant="outline">
                    Discounted
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Scored below what this kind normally gets for being common and/or stale — see the note below.
                </TooltipContent>
              </Tooltip>
            ) : null}
            {expired !== null ? (
              <Badge className={expired ? "text-destructive" : "text-success"} variant="outline">
                {expired ? "Cert expired" : "Cert valid"}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <FaviconThumb kind={node.kind} value={node.value} />
            <CopyValue display={value} value={node.value} />
          </div>
        </div>
        {present(node.contribution) ? (
          <div className="flex flex-col items-end">
            <span className="text-base font-semibold tabular-nums">+{formatNumber(node.contribution ?? node.weight)}</span>
            <span className="text-muted-foreground text-[11px]">points</span>
          </div>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-6">
        {present(node.degree) ? (
          <Metric help="How many entities share this value. Lower is rarer and more telling." label="Shared by" value={node.degree} />
        ) : null}
        {present(node.baseWeight) ? (
          <Metric help="Starting weight for this kind of evidence, before rarity, overlap and recency adjust it." label="Base weight" value={node.baseWeight} />
        ) : null}
        {present(node.rarity) ? (
          <Metric help="Inverse-frequency factor from how widely shared this is — 1.0 is as rare as it gets." label="Rarity" value={node.rarity} />
        ) : null}
        {present(node.timeOverlap) ? (
          <Metric help="Do the two sides' own sighting windows agree with each other?" label="Time overlap" value={node.timeOverlap} />
        ) : null}
        {present(node.recency) && node.recency < 1 ? (
          <Metric help="Staleness factor — how long ago this was last seen at all (lower = older)." label="Recency" value={node.recency} />
        ) : null}
        {present(node.rawWeight) ? (
          <Metric help="Points before related measurements are counted together." label="Before grouping" value={formatNumber(node.rawWeight)} />
        ) : null}
      </dl>

      {node.explanation || node.scoringNote || context.length > 0 || node.evidenceGroup ? (
        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          {context.length > 0 ? <span>Network: {context.join(" · ")}</span> : null}
          {node.evidenceGroup ? <span>Counted with: {formatLabel(node.evidenceGroup)}</span> : null}
          {node.explanation ? <span>{node.explanation}</span> : null}
          {node.scoringNote ? <span>{node.scoringNote}</span> : null}
        </div>
      ) : null}

      {node.kind === "tls_cert_sha256" && (node.certCn || node.certIssuerCn || node.certIssuerOrg || node.certNotAfter) ? (
        <dl className="bg-muted/50 grid gap-1 rounded-md p-2 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-3">
          {node.certCn ? (
            <>
              <dt className="text-muted-foreground">Common name</dt>
              <dd className="font-mono break-all">{node.certCn}</dd>
            </>
          ) : null}
          {node.certIssuerCn || node.certIssuerOrg ? (
            <>
              <dt className="text-muted-foreground">Issued by</dt>
              <dd>{[node.certIssuerOrg, node.certIssuerCn].filter(Boolean).join(" — ")}</dd>
            </>
          ) : null}
          {node.certNotBefore || node.certNotAfter ? (
            <>
              <dt className="text-muted-foreground">Valid</dt>
              <dd>
                {formatWindow([node.certNotBefore, node.certNotAfter])}{" "}
                <span className="text-muted-foreground">(the certificate&apos;s own dates, not our scans)</span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {extraA.length > 0 || extraB.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs">
          {[
            [leftLabel, extraA],
            [rightLabel, extraB],
          ]
            .filter(([, hosts]) => hosts.length > 0)
            .map(([side, hosts]) => (
              <div className="flex flex-wrap items-center gap-1" key={side}>
                <span className="text-muted-foreground">
                  Seen on <span className="text-foreground font-medium">{side}</span> via
                </span>
                {hosts.map((host) => (
                  <Badge className="font-mono" key={host} variant="outline">
                    {host}
                  </Badge>
                ))}
              </div>
            ))}
        </div>
      ) : null}

      <p className="text-muted-foreground text-[11px]">
        {leftLabel || "A"}: {formatWindow(node.windowA)} · {rightLabel || "B"}: {formatWindow(node.windowB)}
        {node.sources?.length ? ` · via ${node.sources.join(", ")}` : " · source unknown"}
      </p>
    </li>
  );
}

export const EvidenceList = memo(function EvidenceList({ evidence, leftLabel, rightLabel }) {
  if (!evidence || evidence.length === 0) {
    return <p className="text-muted-foreground text-sm">No shared attributing evidence — this connection is unsupported.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((node) => (
        <EvidenceItem key={node.id} leftLabel={leftLabel} node={node} rightLabel={rightLabel} />
      ))}
    </ul>
  );
});

function InfrastructureConnectionsFold({ links, leftLabel, onVerdictSaved, showPair }) {
  const [open, setOpen] = useState(false);
  const count = links.length;

  return (
    <Collapsible className="bg-card rounded-lg border" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>
        <button className="hover:bg-muted/60 flex w-full items-center gap-3 rounded-lg p-3 text-left" type="button">
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium">
              {count} {count === 1 ? "link shares" : "links share"} only infrastructure
            </span>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Shared CDN or hosting IPs, ASNs, network blocks, and nameservers need more evidence to show a relationship.
            </p>
          </div>
          <ChevronDownIcon
            className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 border-t p-3">
          {links.map((link, index) => (
            <ConnectionRow
              key={showPair ? `${link.a}|${link.b}` : link.target || index}
              leftLabel={leftLabel}
              link={link}
              onVerdictSaved={onVerdictSaved}
              rightLabel={showPair ? link.b : link.target}
              showPair={showPair}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function kindSummary(evidence) {
  const counts = new Map();
  (evidence || []).forEach((node) => {
    const label = sharedNodeLabel(node.kind);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return [...counts.entries()];
}

const VERDICT_OPTIONS = [
  { value: "same_owner", label: "Same owner" },
  { value: "different_owner", label: "Different owner" },
  { value: "unsure", label: "Unsure" },
];

function verdictLabel(value) {
  return VERDICT_OPTIONS.find((option) => option.value === value)?.label || "Unknown";
}

function hasVerdicts(summary) {
  return Object.values(summary?.counts || {}).some((count) => count > 0) || (summary?.verdicts || []).length > 0;
}

function verdictSummaryText(summary) {
  const counts = summary?.counts || {};
  const present = VERDICT_OPTIONS.filter((option) => counts[option.value] > 0);
  if (present.length === 0) {
    return "No analyst verdicts yet.";
  }
  const decisions = present.map((option) => `${counts[option.value]} ${option.label.toLowerCase()}`).join(", ");
  return present.length > 1 ? `Analysts disagree: ${decisions}.` : `${decisions} verdict${counts[present[0].value] === 1 ? "" : "s"}.`;
}

function VerdictBadges({ summary }) {
  if (!hasVerdicts(summary)) {
    return null;
  }
  return (
    <div aria-label={verdictSummaryText(summary)} className="flex flex-wrap gap-1">
      {VERDICT_OPTIONS.filter((option) => summary.counts[option.value] > 0).map((option) => (
        <Badge key={option.value} variant="outline">
          {option.label} {summary.counts[option.value]}
        </Badge>
      ))}
    </div>
  );
}

function PairVerdicts({ a, b, enabled, initialSummary, onSaved }) {
  const query = a && b ? new URLSearchParams({ a, b }).toString() : null;
  const verdictRequest = useApi(enabled && query ? `/api/verdicts?${query}` : null);
  const [savedSummary, setSavedSummary] = useState(null);
  const [verdict, setVerdict] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const summary = savedSummary || (verdictRequest.data ? normalizeVerdictSummary(verdictRequest.data) : initialSummary) || normalizeVerdictSummary();

  const handleVerdictChange = (value) => {
    if (value) {
      setVerdict(value);
    }
  };

  const save = async () => {
    if (!verdict || !a || !b) {
      return;
    }
    setSaving(true);
    try {
      const response = await fetchJson("/api/verdicts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a, b, verdict, note: note.trim() }),
      });
      const updatedSummary = normalizeVerdictSummary(response);
      setSavedSummary(updatedSummary);
      onSaved(updatedSummary);
      setNote("");
      verdictRequest.refresh();
      toast.success("Verdict saved");
    } catch (error) {
      toast.error(error.message || "Could not save the verdict.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Analyst verdicts" className="flex flex-col gap-4 border-t pt-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Analyst verdicts</span>
        <p className="text-muted-foreground text-sm">{verdictSummaryText(summary)}</p>
        <VerdictBadges summary={summary} />
      </div>

      {verdictRequest.error ? <p className="text-destructive text-sm">Could not refresh verdicts: {verdictRequest.error}</p> : null}
      {summary.verdicts.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {summary.verdicts.map((entry) => (
            <li className="bg-muted/50 flex flex-col gap-1 rounded-md p-2 text-sm" key={entry.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{verdictLabel(entry.verdict)}</Badge>
                <span className="font-medium">{entry.userDisplay || entry.userId || "Analyst"}</span>
                {entry.createdAt ? <span className="text-muted-foreground text-xs">{formatDate(entry.createdAt)}</span> : null}
              </div>
              {entry.note ? <p>{entry.note}</p> : null}
              {entry.evidenceKinds.length > 0 ? (
                <p className="text-muted-foreground text-xs">Evidence reviewed: {entry.evidenceKinds.map(sharedNodeLabel).join(", ")}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <FieldGroup>
        <Field>
          <FieldLabel>Record your assessment</FieldLabel>
          <ToggleGroup onValueChange={handleVerdictChange} size="sm" type="single" value={verdict} variant="outline">
            {VERDICT_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>Save your own assessment. Existing assessments stay visible when analysts disagree.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`verdict-note-${query}`}>Note (optional)</FieldLabel>
          <Textarea id={`verdict-note-${query}`} onChange={(event) => setNote(event.target.value)} placeholder="What evidence supports this assessment?" value={note} />
        </Field>
        <Button className="self-start" disabled={!verdict || saving || !a || !b} onClick={save} size="sm">
          <SaveIcon data-icon="inline-start" />
          {saving ? "Saving…" : "Save verdict"}
        </Button>
      </FieldGroup>
    </section>
  );
}

// One scored connection between two channels: a compact summary row that
// expands into the evidence behind the score. `showPair` renders "a ↔ b"
// (comparison lists); otherwise the row names only the other side, since the
// anchor is the page the analyst is already on.
export const ConnectionRow = memo(function ConnectionRow({ link, leftLabel, onVerdictSaved, rightLabel, showPair = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [savedVerdictSummary, setSavedVerdictSummary] = useState(null);
  const verdictSummary = savedVerdictSummary || link.verdictSummary;
  const kinds = kindSummary(link.evidence);
  const other = rightLabel || link.target;

  return (
    <Collapsible className="bg-card rounded-lg border" onOpenChange={setOpen} open={open}>
      <div className="flex items-center gap-3 p-3">
        <CollapsibleTrigger asChild>
          <button
            className="hover:bg-muted/60 -m-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-md p-1.5 text-left"
            type="button"
          >
            <div className="flex w-14 shrink-0 flex-col items-center">
              <span className="text-xl leading-none font-semibold tabular-nums">{Math.round(link.score ?? 0)}</span>
              <StrengthLabel link={link} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-sm font-medium">
                {showPair ? (
                  <>
                    {leftLabel} <span className="text-muted-foreground">↔</span> {other}
                  </>
                ) : (
                  other
                )}
              </span>
              <div className="flex flex-wrap gap-1">
                {kinds.slice(0, 4).map(([name, count]) => (
                  <Badge key={name} variant="secondary">
                    {name}
                    {count > 1 ? ` ×${count}` : ""}
                  </Badge>
                ))}
                {kinds.length > 4 ? <Badge variant="outline">+{kinds.length - 4} more</Badge> : null}
                {kinds.length === 0 ? <span className="text-muted-foreground text-xs">No evidence recorded</span> : null}
              </div>
              <VerdictBadges summary={verdictSummary} />
            </div>
            <ChevronDownIcon
              className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")}
            />
          </button>
        </CollapsibleTrigger>
        {!showPair && other ? (
          <Button asChild size="sm" variant="ghost">
            <Link aria-label={`Open ${other}`} to={domainUrl(other)}>
              Open
              <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 border-t p-3">
          <EvidenceList evidence={link.evidence} leftLabel={leftLabel || "A"} rightLabel={other || "B"} />
          <PairVerdicts
            a={leftLabel}
            b={other}
            enabled={open}
            initialSummary={verdictSummary}
            onSaved={(summary) => {
              setSavedVerdictSummary(summary);
              onVerdictSaved?.({ a: leftLabel, b: other, summary });
            }}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

// Keep infrastructure-only links available without making a long shared pool
// look like a list of independent findings. Callers may veto individual links
// (Compare does this for pairs explicitly selected by the analyst).
export function ConnectionList({ links, leftLabel, onVerdictSaved, showPair = false, foldInfrastructure = false }) {
  const canFold = typeof foldInfrastructure === "function" ? foldInfrastructure : () => foldInfrastructure;
  const { visible, infrastructure } = partitionInfrastructureOnlyLinks(links, canFold);

  return (
    <>
      {visible.map((link, index) => (
        <ConnectionRow
          key={showPair ? `${link.a}|${link.b}` : link.target || index}
          leftLabel={leftLabel}
          link={link}
          onVerdictSaved={onVerdictSaved}
          rightLabel={showPair ? link.b : link.target}
          showPair={showPair}
        />
      ))}
      {infrastructure.length > 0 ? <InfrastructureConnectionsFold leftLabel={leftLabel} links={infrastructure} onVerdictSaved={onVerdictSaved} showPair={showPair} /> : null}
    </>
  );
}
