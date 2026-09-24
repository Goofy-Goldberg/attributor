"""opencti_sweep.py — the OpenCTI website-channel sweep, shared by its two triggers.

`scripts/ingest_opencti_channels.py` runs it as a blocking Docker command and
`POST /api/ingest/opencti` (the "Import from OpenCTI" button) runs it on a
background thread. Both go through the same steps so they cannot drift:

1. `prepare_sweep` records every channel's tier, drops channels already in
   the pool (unless rescanning), and refreshes labels on the ones it drops.
2. `run_batches` submits the rest as sequential cases, waiting for each to
   finish and attaching its labels before submitting the next. Sequential
   submission keeps the single-worker CaseRuntime free for analysts' own scans
   between batches instead of queueing the whole sweep ahead of them.
3. The caller rebuilds graph materializations (`rebuild_clusters`) at the end.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from cases.case_store import get_job
from core.analysis_service import clean_target, normalize_inputs
from db.intel_db import (
    existing_search_targets,
    get_latest_search_id_for_target,
    registrable_domain,
    save_search_fields,
    set_domain_tier,
)

INPUT_MODE = "opencti_website_full"
TERMINAL_STATUSES = ("completed", "partial", "failed")


@dataclass
class SweepPlan:
    channel_count: int
    tiers_written: int
    to_scan: list[dict[str, Any]]
    skipped: int = 0
    labels_refreshed: int = 0
    normalized_labels: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class SweepResult:
    batches: int = 0
    completed: int = 0
    partial: int = 0
    failed: int = 0
    labels_attached: int = 0
    labels_missing: int = 0


def prepare_sweep(domain_data: dict[str, dict], *, rescan_existing: bool = False) -> SweepPlan:
    """Record tiers for every channel and decide which domains still need a scan.

    `domain_data` is `fetch_all_website_channel_data()`'s
    {domain: {"labels": [...], "tier": int | None}} map.
    """
    # Tier is durable, per-domain classification, independent of any one
    # scan's success — set it up front so it's recorded even if a domain's
    # analysis later fails or times out. domain_tiers is keyed on the
    # *registrable* domain (same rollup key domain_profile/graph lookups
    # use), so a channel resolving to a subdomain still needs collapsing to
    # its apex here, or the tier would be stored under a key nothing ever
    # looks up.
    tiers_written = 0
    for domain, entry in domain_data.items():
        if entry["tier"] is None:
            continue
        apex = registrable_domain(clean_target(domain))
        if not apex:
            continue
        set_domain_tier(apex, entry["tier"], source="opencti")
        tiers_written += 1

    inputs = normalize_inputs(list(domain_data.keys()))
    # Labels are keyed by clean_target() so lookups line up exactly with the
    # normalized_target each search was actually saved under.
    normalized_labels = {
        clean_target(domain): entry["labels"]
        for domain, entry in domain_data.items()
        if entry["labels"]
    }
    plan = SweepPlan(
        channel_count=len(domain_data),
        tiers_written=tiers_written,
        to_scan=inputs,
        normalized_labels=normalized_labels,
    )
    if rescan_existing or not inputs:
        return plan

    # Skip channels already in the pool: the analysis pipeline is the expensive
    # part, and a channel with an existing search has already been through it.
    # Tiers were recorded above for *every* channel regardless, and labels for
    # skipped channels are refreshed here (they already have a search to attach
    # to), so only the re-scan is avoided — not the durable metadata.
    already = existing_search_targets([item["normalized_target"] for item in inputs])
    skipped_inputs = [item for item in inputs if item["normalized_target"] in already]
    plan.to_scan = [item for item in inputs if item["normalized_target"] not in already]
    plan.skipped = len(skipped_inputs)
    if skipped_inputs:
        plan.labels_refreshed, _ = attach_labels(skipped_inputs, normalized_labels)
    return plan


def split_batches(inputs: list[dict[str, Any]], batch_size: int) -> list[list[dict[str, Any]]]:
    """Split into sequential batches; batch_size <= 0 means one batch for everything."""
    size = batch_size if batch_size and batch_size > 0 else max(len(inputs), 1)
    return [inputs[i : i + size] for i in range(0, len(inputs), size)]


def attach_labels(batch_inputs: list[dict[str, Any]], normalized_labels: dict[str, list[str]]) -> tuple[int, int]:
    """Attach OpenCTI labels to each domain's latest search as `opencti_labels`."""
    attached = 0
    missing = 0
    for item in batch_inputs:
        domain = item["normalized_target"]
        labels = normalized_labels.get(domain)
        if not labels:
            continue
        sid = get_latest_search_id_for_target(domain)
        if sid is None:
            missing += 1
            continue
        save_search_fields(sid, {"opencti_labels": labels})
        attached += 1
    return attached, missing


def wait_for_job(
    job_id: str,
    *,
    poll_interval: float,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[str, dict[str, Any] | None]:
    """Block until the job reaches a terminal status; return (status, job row)."""
    while True:
        job = get_job(job_id)
        if job is None:
            return "failed", None
        if on_progress is not None:
            on_progress(job)
        if job.get("status") in TERMINAL_STATUSES:
            return job["status"], job
        time.sleep(poll_interval)


def run_batches(
    submit: Callable[[list[dict[str, Any]]], dict[str, str]],
    batches: list[list[dict[str, Any]]],
    normalized_labels: dict[str, list[str]],
    *,
    poll_interval: float,
    first_job_id: str | None = None,
    log: Callable[[str], None] = lambda _message: None,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> SweepResult:
    """Submit each batch as a case, wait for it, attach its labels, then move on.

    `submit(batch_inputs)` returns CaseRuntime.submit_case's identifiers. Pass
    `first_job_id` when the caller already submitted batches[0] itself (the API
    does, so it can hand that job straight back to the browser). A partial or
    failed batch does not abort the sweep; the result counts each outcome.
    """
    result = SweepResult(batches=len(batches))
    for batch_num, batch_inputs in enumerate(batches, 1):
        log(f"\n=== Batch {batch_num}/{len(batches)} ({len(batch_inputs)} domain(s)) ===")
        if batch_num == 1 and first_job_id:
            job_id = first_job_id
        else:
            identifiers = submit(batch_inputs)
            job_id = identifiers["job_id"]
            log(f"Submitted case {identifiers['case_id']} (job {job_id}). Waiting for it to finish...")

        status, job = wait_for_job(job_id, poll_interval=poll_interval, on_progress=on_progress)
        if job is None:
            log("error: job disappeared mid-run")
        else:
            log(f"Case {status}.")
            if job.get("error"):
                log(f"  error: {job['error']}")
        if status == "failed":
            result.failed += 1
        elif status == "partial":
            result.partial += 1
        else:
            result.completed += 1

        attached, missing = attach_labels(batch_inputs, normalized_labels)
        result.labels_attached += attached
        result.labels_missing += missing
        log(f"  attached labels to {attached} domain(s); {missing} had labels but no matching search result.")
    return result
