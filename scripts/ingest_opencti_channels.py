"""ingest_opencti_channels.py — sweep every OpenCTI website Channel into the pool.

Fetches *all* Channel SDOs on OpenCTI with channel_types containing
"website", runs each resolved domain through the same full
ingestion pipeline as a normal case submission (core/basic.py's analyze()
plus analysis_service's parity enrichments, subdomain/sibling follow-ups,
and db/intel_db.py correlation).

Two kinds of OpenCTI label data get attached to each domain:

- tier (tier-1..tier-5, the only labels that matter for classification —
  see integrations/opencti_ingest._extract_tier) is written to the durable
  domain_tiers table, keyed by registrable domain rather than a specific
  scan. It survives rescans and is what colours nodes in the network graph.
- the full label list is attached to the scan's own result as
  `opencti_labels`, same as before — informational only.

The same sweep (integrations/opencti_sweep.py) backs the "Import from
OpenCTI" button in the web UI. This command is the blocking, operator-run
form, with --dry-run / --rescan-existing / --batch-size:

    docker compose exec ip-intel python -m scripts.ingest_opencti_channels

Requires OPENCTI_URL / OPENCTI_TOKEN (already set via .env in the container).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from cases.case_runtime import CaseRuntime
from db.intel_db import rebuild_clusters
from integrations.opencti_ingest import fetch_all_website_channel_data
from integrations.opencti_sweep import INPUT_MODE, prepare_sweep, run_batches, split_batches


def _configure_logging() -> None:
    """Surface the ``ip_intel.*`` loggers on stdout for this detached sweep.

    The analysis pipeline runs on CaseRuntime background threads and reports
    progress through the ``ip_intel`` logger family (see
    ``cases/case_runtime.CaseRuntime._log`` and ``core/basic.py``'s log hook).
    Unlike the web app, this script never imports ``cases/case_app.py``, so
    nothing has attached a handler to that logger — INFO lines would be dropped
    and only WARNING+ would leak to stderr via logging's last-resort handler.
    Attach a stdout handler on the shared ``ip_intel`` parent (children
    propagate to it) so *all* per-domain scan progress lands in the logfile the
    operator redirects stdout to. This mirrors
    ``cases/case_app._configure_logging`` intentionally rather than importing
    it, to avoid spinning up the FastAPI app and a second CaseRuntime just for
    log setup. Level honours IP_INTEL_LOG_LEVEL (default INFO).
    """
    level_name = os.environ.get("IP_INTEL_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger("ip_intel")
    root.setLevel(level)
    if not any(getattr(h, "_ip_intel", False) for h in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler._ip_intel = True  # type: ignore[attr-defined]
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )
        root.addHandler(handler)
    root.propagate = False


def _progress_signature(job: dict) -> tuple:
    """The fields whose change is worth a new progress line.

    Excludes `current_target`: with a concurrent analysis pool it flips on every
    poll without any real forward motion, which is what produced pages of
    identical `[10%] ... done=23/303` lines. Keying on the counts instead means
    one line per actual completion/failure or stage change."""
    return (
        job.get("stage"),
        job.get("percent") or 0,
        job.get("completed_targets") or 0,
        job.get("failed_targets") or 0,
        job.get("total_targets") or 0,
    )


def _print_progress(job: dict) -> None:
    stage = job.get("stage") or "?"
    percent = job.get("percent") or 0
    done = job.get("completed_targets") or 0
    failed = job.get("failed_targets") or 0
    total = job.get("total_targets") or 0
    # In-flight/queued = everything not yet resolved. Surfacing it makes clear
    # the job is progressing even while `done` sits still (targets being
    # analyzed concurrently) and explains why `total` climbs as discovered
    # follow-ups get queued.
    remaining = max(total - done - failed, 0)
    current = job.get("current_target") or ""
    print(
        f"  [{percent:3d}%] stage={stage:<12} done={done}/{total} "
        f"failed={failed} pending={remaining}  last={current}",
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and print the domain/tier/label list from OpenCTI without ingesting anything.",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=5.0,
        help="Seconds between job-status polls while ingestion runs (default: 5).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=250,
        help=(
            "Number of domains per case. The sweep is split into sequential "
            "batches so each one completes and persists (tiers, labels, scans) "
            "before the next starts — a crash or restart only loses the batch "
            "in flight, not the whole run. Set to 0 for a single case (default: 250)."
        ),
    )
    parser.add_argument(
        "--rescan-existing",
        action="store_true",
        help=(
            "Re-run the full analysis pipeline on channels that already have a "
            "search in the DB. By default those are skipped (only their tier and "
            "labels are refreshed) so a sweep only scans channels new to the pool."
        ),
    )
    args = parser.parse_args()

    # Route the analysis pipeline's ip_intel.* log lines to stdout so a
    # detached run (stdout redirected to a logfile) shows live per-domain
    # scan progress, not just the coarse _print_progress percentages.
    _configure_logging()

    print("Fetching website channels from OpenCTI...")
    try:
        domain_data = fetch_all_website_channel_data()
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

    if not domain_data:
        print("No website-channel domains found on OpenCTI. Nothing to do.")
        return

    tiered_count = sum(1 for entry in domain_data.values() if entry["tier"] is not None)
    print(f"Found {len(domain_data)} domain(s) from website channels ({tiered_count} with a tier label).")

    if args.dry_run:
        for domain in sorted(domain_data):
            entry = domain_data[domain]
            tier_text = f"tier {entry['tier']}" if entry["tier"] is not None else "no tier"
            labels_text = f"  [{', '.join(entry['labels'])}]" if entry["labels"] else ""
            print(f"  {domain}  ({tier_text}){labels_text}")
        return

    print("Recording domain tiers and checking which channels are already in the pool...")
    plan = prepare_sweep(domain_data, rescan_existing=args.rescan_existing)
    print(f"  set tier on {plan.tiers_written} domain(s).")
    if plan.skipped:
        print(
            f"Skipping {plan.skipped} channel(s) already in the DB "
            f"(refreshed labels on {plan.labels_refreshed}). {len(plan.to_scan)} new channel(s) to scan."
        )

    if not plan.to_scan:
        print("No new channels to scan.")
        print("Rebuilding graph materializations...")
        graph_counts = rebuild_clusters()
        print(f"  graph rebuild: {graph_counts}")
        return

    # Split into sequential batches so each case completes and persists before
    # the next starts. With thousands of domains this keeps a single job from
    # running for many hours, makes progress durable (a crash only loses the
    # in-flight batch), and attaches labels incrementally rather than only at
    # the very end.
    batches = split_batches(plan.to_scan, args.batch_size)
    runtime = CaseRuntime()
    result = run_batches(
        lambda batch_inputs: runtime.submit_case(batch_inputs, input_mode=INPUT_MODE),
        batches,
        plan.normalized_labels,
        poll_interval=args.poll_interval,
        log=lambda message: print(message, flush=True),
        on_progress=_ProgressPrinter(),
    )

    print(
        f"\nAll batches done: {result.completed}/{result.batches} completed, "
        f"{result.partial} partial, {result.failed} failed. Attached labels to {result.labels_attached} domain(s) "
        f"({result.labels_missing} unmatched)."
    )

    print("Rebuilding graph materializations...")
    graph_counts = rebuild_clusters()
    print(f"  graph rebuild: {graph_counts}")

    if result.failed or result.partial:
        sys.exit(1)


class _ProgressPrinter:
    """Print a progress line only when the job's counts or stage actually moved,
    so the poll cadence no longer floods the log with identical snapshots."""

    def __init__(self) -> None:
        self._last = None

    def __call__(self, job: dict) -> None:
        signature = _progress_signature(job)
        if signature != self._last:
            _print_progress(job)
            self._last = signature


if __name__ == "__main__":
    main()
