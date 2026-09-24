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
    deferred: int = 0
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


def select_inputs(
    domain_data: dict[str, dict], *, rescan_existing: bool = False, limit: int | None = None,
) -> tuple[list[dict[str, Any]], set[str], list[dict[str, Any]]]:
    """Read-only selection shared by the sweep and CLI preview."""
    if limit is not None and (isinstance(limit, bool) or limit < 1):
        raise ValueError("limit must be a positive integer")

    inputs = normalize_inputs(sorted(domain_data) if limit is not None else list(domain_data))
    targets = {item["normalized_target"] for item in inputs}
    already = set() if rescan_existing or not inputs else existing_search_targets(list(targets)) & targets
    new_inputs = [item for item in inputs if item["normalized_target"] not in already]
    to_scan = new_inputs[:limit] if limit is not None else new_inputs
    return inputs, already, to_scan


def prepare_sweep(
    domain_data: dict[str, dict], *, rescan_existing: bool = False, limit: int | None = None,
) -> SweepPlan:
    """Select domains to scan and write metadata for the selected scope.

    `domain_data` is `fetch_all_website_channel_data()`'s
    {domain: {"labels": [...], "tier": int | None}} map.
    """
    inputs, already, to_scan = select_inputs(
        domain_data, rescan_existing=rescan_existing, limit=limit,
    )
    skipped_inputs = [item for item in inputs if item["normalized_target"] in already]
    metadata_inputs = to_scan if limit is not None else inputs

    # Record tiers before scanning; collapse subdomains to the durable apex key.
    tiers_written = 0
    for item in metadata_inputs:
        domain = item["input_value"]
        entry = domain_data[domain]
        if entry["tier"] is None:
            continue
        apex = registrable_domain(clean_target(domain))
        if not apex:
            continue
        set_domain_tier(apex, entry["tier"], source="opencti")
        tiers_written += 1

    normalized_labels = {
        item["normalized_target"]: domain_data[item["input_value"]]["labels"]
        for item in metadata_inputs
        if domain_data[item["input_value"]]["labels"]
    }
    plan = SweepPlan(
        channel_count=len(domain_data),
        tiers_written=tiers_written,
        to_scan=to_scan,
        skipped=len(skipped_inputs),
        deferred=len(inputs) - len(already) - len(to_scan),
        normalized_labels=normalized_labels,
    )
    if skipped_inputs and limit is None:
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
