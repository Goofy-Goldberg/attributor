---
read_when: Reviewing relationship weights, resuming ingestion, or sizing Attributor hosting
---

# Initial relationship review

22 September 2026. Source baseline: `032d1f6`.

This is a code and fixture review, not validation of the approximately 700
ingested channels. The localhost address referred to Eoin's setup. No running
instance or database export was available. The repository contains one saved
`rt.com` scan dated 19 August 2026. No ingestion, rescanning, remote changes,
deployment, or graph rebuild was performed against Eoin's data.

## Requirements for the remaining review

- **Data access:** a read-only database export or access to Eoin's populated
  instance, together with its deployed commit and ingestion scheduler settings.
  This is required for the 10–20-channel evidence check, a populated frontend
  audit, and measurements of rebuild time, memory and response time.
- **Meaning of a relationship:** confirm whether the primary goal is shared
  infrastructure, likely common operators, or both. The recommended distinction
  is to show shared infrastructure as an observation and common operation as
  an assessment requiring corroboration. Until confirmed, scores rank shared
  evidence and must not be presented as ownership probabilities.

These requirements do not block local fixes to missing DNS verification
evidence, duplicate score contributions or score explanations. Weight
calibration, historical-evidence policy, ingestion restart and hosting decisions
remain pending the data and intended interpretation. No credentials are needed
in this document; use an export or an authorized read-only connection.

## Findings

| Priority | Finding | Evidence and action |
| --- | --- | --- |
| High | Live TLS observations used certificate validity dates | `extract_selectors` used `not_before`/`not_after` for certificate, SPKI and SAN observation windows. A 2020 scan with a certificate valid through 2030 received full freshness credit. Fixed live probes and origin scans to use scan time; retained certificate metadata. Existing stored projections require full recompute after deployment. |
| High | DNS verification tokens did not reach the graph | Fixed locally: recognized DNS proofs now use HTML's canonical `site_verification` selector and existing 92-point base weight. Case-sensitive tokens remain distinct; identical DNS/HTML proofs share one contribution and retain both sources. Unknown providers stay in the identifier layer. Existing data needs full recompute. |
| High | Correlated evidence could create a strong relationship alone | Fixed locally with a conservative family cap: only the strongest adjusted favicon match and strongest adjusted TLS match contribute per pair. Two favicon hashes now score 45 instead of 85, producing moderate evidence. Certificate/key/SAN matches no longer add together; every row remains inspectable with its contribution and explanation. Independent assets within a family are also capped until asset-level provenance is available. |
| Medium | Percentages suggest more certainty than established | Confidence is an uncalibrated score transformation. Rounding is capped at 99, and cards/printable reports now show raw Match score and evidence-strength labels instead of percentages. The API/CSV confidence field remains for compatibility. Calibration still requires reviewed pairs. |
| Medium | Historical evidence needs source-specific dates | The follow-up implementation uses CT log entry time when supplied and minimum freshness credit when it is unknown. Certificate validity and retrieval are stored separately and do not assert current deployment. Provider IP hits may still lack original observation dates, so analysts should read each source's provenance before treating it as current. A full graph recompute is required for existing data. |
| Medium | Cluster membership and scored links have different rules | `rebuild_clusters` joins connected components through eligible selectors/IPs with fanout 2–25, without applying the link's score or recency. Pairwise scores use other thresholds and degree rules. A shared weak signal can create cluster membership; a high-fanout identity signal may link domains without joining their clusters. This may be intentional but must be explained to analysts. |

## Weight assessment

The model has useful safeguards: provider noise filtering, rarity weighting,
time separation, freshness decay, and per-link evidence explanations. However,
their presence does not establish precision on the current collection.

Current examples before rarity/time penalties are TLS certificate 200,
AdSense 190, GA property 170, SSH key 95, verification token 92, IP 85,
nameserver 25 and ASN 15. A TLS certificate alone scores about 75% on the
displayed scale. That is a ranking convention, not 75% ownership certainty.
The 65-point strong threshold still lets several weak observations cross into
strong. The family caps remove obvious redundant contributions, but do not
establish that all remaining observations are independent.

Keep the base weights unchanged until reviewed positive and negative examples are
available. In particular, test shared hosting, common templates, agency-managed
analytics, expired evidence, redirects, and default virtual hosts. Shared
infrastructure should be distinguished from shared administration and ownership.
TLS relaying can also expose a genuine certificate on someone else's host;
[Censys documents this attribution pitfall](https://censys.com/blog/hey-thats-not-my-server).

## Frontend recommendations

These are source-based recommendations, not a visual or accessibility audit of
Eoin's collection. The follow-up changes were checked in the in-app browser
using two synthetic channels; the actual collection remains unavailable.

1. Implemented locally: connection cards and printable reports label raw Match
   score, explain that it is not an ownership probability, and retain observation
   dates in expanded evidence. Adjusted contributions explain which related
   measurements added no points. Further layout decisions await the real dataset.
2. Distinguish direct shared evidence, a multi-hop path and cluster membership.
   The step-by-step path cards and printable report now explain that each score
   applies to its own pair, not the endpoints of the whole chain. Cluster
   membership semantics still require the intended relationship definition.
3. Show provider/collection failures alongside evidence coverage. Missing data
   must be distinguishable from a scan that found no match. The saved scan, for
   example, contains a CIRCL HTTP 401 error.
4. Make truncation explicit. Path exploration defaults to three hops, 200
   reachable domains and the top 50 outgoing links per step. Connection counts
   are also capped at 50 in rebuild output. A missing path does not prove
   absence of a relationship; capped counts should read “50+” or expose totals.
5. Prefer a selected channel and its evidence table as the entry point for
   investigation, with the graph used to explore the selected relationships.
   Validate label readability, keyboard selection, contrast and large-graph
   interaction on the populated instance before changing the visual design.

## Ingestion and hosting

Do not resume unattended ingestion on the basis of this review. Its disabled
state was reported by the user and was not verified live. Deploy the timestamp
fix, rebuild derived data, then review the sample below before approving a
small monitored batch. No setting has been changed here.

There is not enough evidence to recommend Iris or a particular server size.
The single stored scan projects to 1,960 entities, 249 observations and 2,833
structural edges locally; this is not a count of confirmed relationships or a
representative per-channel average. The rebuild scores every registrable domain,
retains all scored links in memory and materializes capped paths. Large fanout
can therefore matter more than the number of seed channels. Compose caps the
app at 6 GiB, which is a configuration value, not a measured requirement.

Measure total entities/selectors/edges, graph density, rebuild duration, peak
app and PostgreSQL memory, CPU, query latency, and browser responsiveness on the
existing dataset. Check query plans and worker concurrency before purchasing
capacity. Move hosting when measured resource limits or service objectives
justify it; additional hardware cannot correct false relationships.

## Completing the empirical review

Obtain a read-only database export or access to Eoin's instance plus its deployed
commit and ingestion scheduler configuration. Select 15 seed channels spanning
all available tiers: five high-degree, five medium-degree and five low-degree
or isolated channels, including stale and failed scans. Record the selection
and tier coverage so the sample is reproducible.

For each channel, inspect strongest links plus at least one weak or suspicious
link and a plausible missing link. Capture both raw observations, source/host,
actual observation dates, selector degree, contribution and final score. Mark
supported shared infrastructure, plausible shared operator, false positive,
missing relationship or unresolved; give a reason and confidence in the review.
Inspect shared-hosting controls and redundant selectors explicitly. This sample
is a diagnostic review, not a statistically reliable accuracy estimate.

Questions for Eoin: Does “related” mean shared infrastructure or shared operator?
Should historic relationships remain prominent? What evidence justifies a
“strong” label? Are cluster membership and path limits understood? What refresh
interval and response-time targets should determine ingestion and hosting?

## Verification

The initial review ran the focused checks below without PostgreSQL. Follow-up
verification used a disposable PostgreSQL 16 container and covered DNS
projection/persistence, cross-DNS/HTML matches, case-sensitive proofs,
contribution caps, graph maintenance and existing storage regressions:
**88 tests and six subtests passed, with no skips.** The
frontend production build passed. React Doctor reported existing patterns in
changed files (fetching in effects, chained array operations, formatter creation
and mixed exports); this change did not add those patterns, and they were left
outside scope.

The synthetic browser check verified the collapsed Match score card and expanded
evidence: one DNS/HTML proof contributes 92 points, one favicon contributes 45,
and its other hash remains visible with 0 points and a scoring explanation.
Bundled frontend assertions checked printable-report wording, CSV compatibility,
normalization of zero contributions and the legacy confidence cap. The temporary
browser tab, server and database are removed after verification.

`npm ci` initially failed because the lockfile omitted optional platform packages.
The lockfile repair added those entries without changing existing locked package
versions or declared dependencies. It is included so clean installations work.
The read-only `codex-review --mode auto` closeout reported no actionable findings.

The full suite, real-data replay, populated-collection UX audit and production
load testing remain unperformed. A full graph recompute is still required on an
authorized deployment before existing cached relationships reflect these fixes.

### Initial review checks

Focused command: `.venv/bin/python -m pytest tests/test_graph_linkage.py tests/test_graph_maintenance.py -q`.
Result: 31 passed, 21 skipped, six TLS-source subtests passed. Database-dependent
tests skipped because the configured test PostgreSQL service was unavailable.
Regressions cover old live scans with future-valid certificates across all six
supported source shapes and large scores rounding to certainty. The full suite,
database replay, browser audit and production-scale performance checks were not
run. No conclusion about real-channel false-positive rates is claimed.
