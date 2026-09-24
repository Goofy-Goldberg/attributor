"""The OpenCTI pilot limit applies before any database writes."""

import sys

from integrations import opencti_sweep
from scripts import ingest_opencti_channels as sweep


def test_limited_dry_run_selects_new_domains_in_stable_order(monkeypatch, capsys):
    data = {
        "zeta.example": {"labels": [], "tier": None},
        "alpha.example": {"labels": [], "tier": 1},
        "beta.example": {"labels": [], "tier": None},
        "gamma.example": {"labels": [], "tier": None},
    }
    monkeypatch.setattr(sweep, "fetch_all_website_channel_data", lambda: data)
    monkeypatch.setattr(opencti_sweep, "existing_search_targets", lambda targets: {"alpha.example"})
    monkeypatch.setattr(opencti_sweep, "set_domain_tier", lambda *args, **kwargs: raise_unexpected_write())
    monkeypatch.setattr(sys, "argv", ["ingest_opencti_channels", "--dry-run", "--limit", "2"])

    sweep.main()

    output = capsys.readouterr().out
    assert "  beta.example  (no tier)" in output
    assert "  gamma.example  (no tier)" in output
    assert "  alpha.example  (tier 1)" not in output
    assert "  zeta.example  (no tier)" not in output


def raise_unexpected_write():
    raise AssertionError("dry run attempted a database write")


def test_limit_skips_existing_before_capping(monkeypatch):
    data = {
        "gamma.example": {"labels": ["tier-3"], "tier": 3},
        "beta.example": {"labels": ["tier-2"], "tier": 2},
        "alpha.example": {"labels": ["tier-1"], "tier": 1},
    }
    monkeypatch.setattr(opencti_sweep, "existing_search_targets", lambda targets: {"alpha.example"})
    _, _, selected = opencti_sweep.select_inputs(data, limit=1)
    assert [item["normalized_target"] for item in selected] == ["beta.example"]
