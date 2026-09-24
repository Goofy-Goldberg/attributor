"""The OpenCTI sweep must stop polling on every terminal job outcome."""

from unittest.mock import Mock

import pytest

from integrations import opencti_sweep


@pytest.mark.parametrize("status", ["completed", "partial", "failed"])
def test_run_batches_stops_on_terminal_status(monkeypatch, status):
    submit = Mock(return_value={"case_id": "case-1", "job_id": "job-1"})
    monkeypatch.setattr(opencti_sweep, "get_job", lambda _job_id: {
        "status": status, "stage": "notification", "percent": 100,
        "total_targets": 1, "completed_targets": int(status == "completed"),
        "partial_targets": int(status == "partial"), "failed_targets": int(status == "failed"),
    })
    monkeypatch.setattr(opencti_sweep.time, "sleep", lambda _seconds: pytest.fail("polled after terminal status"))

    result = opencti_sweep.run_batches(submit, [[]], {}, poll_interval=0)

    assert (result.completed, result.partial, result.failed) == (
        int(status == "completed"), int(status == "partial"), int(status == "failed"),
    )


def test_run_batches_reuses_a_presubmitted_first_batch(monkeypatch):
    submit = Mock(return_value={"case_id": "case-2", "job_id": "job-2"})
    polled: list[str] = []
    monkeypatch.setattr(opencti_sweep, "get_job", lambda job_id: polled.append(job_id) or {"status": "completed"})

    result = opencti_sweep.run_batches(submit, [[], []], {}, poll_interval=0, first_job_id="job-1")

    assert submit.call_count == 1
    assert polled == ["job-1", "job-2"]
    assert result.completed == 2


def test_prepare_sweep_skips_channels_already_in_the_pool(monkeypatch):
    tiers: list[tuple] = []
    saved: dict = {}
    monkeypatch.setattr(opencti_sweep, "set_domain_tier", lambda domain, tier, source: tiers.append((domain, tier)))
    monkeypatch.setattr(opencti_sweep, "existing_search_targets", lambda targets: {"old.example"})
    monkeypatch.setattr(opencti_sweep, "get_latest_search_id_for_target", lambda _domain: 7)
    monkeypatch.setattr(opencti_sweep, "save_search_fields", lambda sid, fields: saved.update({sid: fields}))

    plan = opencti_sweep.prepare_sweep({
        "old.example": {"labels": ["tier-2"], "tier": 2},
        "new.example": {"labels": [], "tier": None},
    })

    assert tiers == [("old.example", 2)]
    assert [item["normalized_target"] for item in plan.to_scan] == ["new.example"]
    assert (plan.skipped, plan.labels_refreshed) == (1, 1)
    assert saved == {7: {"opencti_labels": ["tier-2"]}}


def test_prepare_sweep_limits_new_domains_and_metadata(monkeypatch):
    tiers = []
    refreshed = []
    monkeypatch.setattr(opencti_sweep, "set_domain_tier", lambda domain, tier, source: tiers.append((domain, tier)))
    monkeypatch.setattr(opencti_sweep, "existing_search_targets", lambda targets: {"alpha.example"})
    monkeypatch.setattr(opencti_sweep, "attach_labels", lambda *args: refreshed.append(args) or (0, 0))

    plan = opencti_sweep.prepare_sweep({
        "gamma.example": {"labels": ["tier-3"], "tier": 3},
        "beta.example": {"labels": ["tier-2"], "tier": 2},
        "alpha.example": {"labels": ["tier-1"], "tier": 1},
    }, limit=1)

    assert [item["normalized_target"] for item in plan.to_scan] == ["beta.example"]
    assert (plan.skipped, plan.deferred, plan.tiers_written) == (1, 1, 1)
    assert plan.normalized_labels == {"beta.example": ["tier-2"]}
    assert tiers == [("beta.example", 2)]
    assert refreshed == []
