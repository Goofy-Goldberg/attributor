"""The OpenCTI sweep must stop polling on every terminal job outcome."""

from unittest.mock import Mock

import pytest

from scripts import ingest_opencti_channels


@pytest.mark.parametrize("status", ["completed", "partial", "failed"])
def test_run_batch_stops_on_terminal_status(monkeypatch, status):
    runtime = Mock()
    runtime.submit_case.return_value = {"case_id": "case-1", "job_id": "job-1"}
    monkeypatch.setattr(ingest_opencti_channels, "get_job", lambda _job_id: {
        "status": status, "stage": "notification", "percent": 100,
        "total_targets": 1, "completed_targets": int(status == "completed"),
        "partial_targets": int(status == "partial"), "failed_targets": int(status == "failed"),
    })
    monkeypatch.setattr(ingest_opencti_channels.time, "sleep", lambda _seconds: pytest.fail("polled after terminal status"))

    assert ingest_opencti_channels._run_batch(runtime, [], poll_interval=0) == status
