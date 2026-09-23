import { ArrowRightIcon, ChevronDownIcon, CopyIcon, InfoIcon } from "lucide-react";
import { memo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { formatDate, formatLabel, formatNumber } from "@/api.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

function kindSummary(evidence) {
  const counts = new Map();
  (evidence || []).forEach((node) => {
    const label = sharedNodeLabel(node.kind);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return [...counts.entries()];
}

// One scored connection between two channels: a compact summary row that
// expands into the evidence behind the score. `showPair` renders "a ↔ b"
// (comparison lists); otherwise the row names only the other side, since the
// anchor is the page the analyst is already on.
export const ConnectionRow = memo(function ConnectionRow({ link, leftLabel, rightLabel, showPair = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
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
        <div className="border-t p-3">
          <EvidenceList evidence={link.evidence} leftLabel={leftLabel || "A"} rightLabel={other || "B"} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
