---
read_when: Reviewing relationship weights, resuming ingestion, or sizing Attributor hosting
---

# Initial relationship review

22 September 2026. Source baseline: `032d1f6`.

This is a code and fixture review, not validation of the approximately 700
ingested channels. The localhost address referred to Eoin's setup. No running
instance or database export was available. The repository contains one saved
`rt.com` scan dated 19 August 2026. No ingestion, rescanning, remote changes,
deployment, or graph rebuild was performed.

## Findings

| Priority | Finding | Evidence and action |
| --- | --- | --- |
| High | Live TLS observations used certificate validity dates | `extract_selectors` used `not_before`/`not_after` for certificate, SPKI and SAN observation windows. A 2020 scan with a certificate valid through 2030 received full freshness credit. Fixed live probes and origin scans to use scan time; retained certificate metadata. Existing stored projections require full recompute after deployment. |
| High | DNS verification tokens do not reach the graph | A payload with `google-site-verification=same-token` produces a legacy identifier but zero selector observations. `extract_selectors` never emits `dns_txt_token`, although the scorer has DNS/HTML deduplication. Not fixed here: choose canonical provider names and explicit weight first; DNS currently uses `google_site_verification`, HTML uses `google`, and the DNS kind has no dedicated base weight. |
| High | Correlated evidence can create a strong relationship alone | Two fresh, rare favicon hashes (MD5 and MMH3) score 40 + 45 = 85, with strength `strong` and displayed confidence 57. Both can describe the same icon. Consider one contribution per asset/evidence family, retaining both hashes for inspection. Certificate, public-key and SAN overlap warrants the same review. Do not treat these as independent confirmations. |
| Medium | Percentages suggest more certainty than established | Confidence is `round(100 * score / (score + 65))`, not a probability fitted to reviewed pairs. At score 13,000 it rounded to 100 despite its documented promise never to imply certainty. Fixed rounding to cap at 99; calibration and UI wording remain open. |
| Medium | Historical evidence still needs a separate temporal policy | CT SANs still use validity dates, whereas provider IP hits generally use collection time. Fetching historical evidence today does not establish that it is currently deployed. Keep issuance, provider observation and retrieval times distinct before interpreting freshness across sources. The live-probe correction does not resolve this broader issue. |
| Medium | Cluster membership and scored links have different rules | `rebuild_clusters` joins connected components through eligible selectors/IPs with fanout 2–25, without applying the link's score or recency. Pairwise scores use other thresholds and degree rules. A shared weak signal can create cluster membership; a high-fanout identity signal may link domains without joining their clusters. This may be intentional but must be explained to analysts. |

## Weight assessment

The model has useful safeguards: provider noise filtering, rarity weighting,
time separation, freshness decay, and per-link evidence explanations. However,
their presence does not establish precision on the current collection.

Current examples before rarity/time penalties are TLS certificate 200,
AdSense 190, GA property 170, SSH key 95, verification token 92, IP 85,
nameserver 25 and ASN 15. A TLS certificate alone scores about 75% on the
displayed scale. That is a ranking convention, not 75% ownership certainty.
The 65-point strong threshold also lets several weak or redundant observations
cross into strong without independent evidence.

Keep the weights unchanged until reviewed positive and negative examples are
available. In particular, test shared hosting, common templates, agency-managed
analytics, expired evidence, redirects, and default virtual hosts. Shared
infrastructure should be distinguished from shared administration and ownership.
TLS relaying can also expose a genuine certificate on someone else's host;
[Censys documents this attribution pitfall](https://censys.com/blog/hey-thats-not-my-server).

## Frontend recommendations

These are source-based recommendations, not a visual or accessibility audit.
No screenshots or populated UI interactions were possible without the instance.

1. Connection cards prominently show a percentage and strength badge
   (`frontend/src/features/evidence.jsx`). Label the number as a heuristic match
   score and explain that it is not an ownership probability. Make the strongest
   independent evidence and observation dates immediately visible.
2. Distinguish direct shared evidence, a multi-hop path and cluster membership.
   The existing step-by-step path cards are a useful foundation; a path must not
   imply that its endpoints share an operator.
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

Focused command: `.venv/bin/python -m pytest tests/test_graph_linkage.py tests/test_graph_maintenance.py -q`.
Result: 31 passed, 21 skipped, six TLS-source subtests passed. Database-dependent
tests skipped because the configured test PostgreSQL service was unavailable.
Regressions cover old live scans with future-valid certificates across all six
supported source shapes and large scores rounding to certainty. The full suite,
database replay, browser audit and production-scale performance checks were not
run. No conclusion about real-channel false-positive rates is claimed.
