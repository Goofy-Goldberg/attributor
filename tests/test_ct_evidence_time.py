"""CT log dates must not be confused with certificate validity or retrieval."""

from core import basic
from db import intel_db
from utils import check


def _ct_observation(cert, *, timestamp="2026-09-23T12:00:00+00:00"):
    projected = intel_db.extract_selectors({
        "input": "example.org",
        "timestamp": timestamp,
        "crt_sh": {"certs": [cert]},
    })
    return next(row for row in projected["observations"] if row["kind"] == "tls_san")


def test_ct_log_date_is_source_evidence_not_validity_or_retrieval():
    row = _ct_observation({
        "sans": ["example.org"],
        "source_observed_at": "2020-01-02T03:04:05+00:00",
        "not_before": "2019-12-01T00:00:00+00:00",
        "not_after": "2099-12-01T00:00:00+00:00",
    })
    assert row["first_seen"] == "2020-01-02T03:04:05+00:00"
    assert row["last_seen"] == "2020-01-02T03:04:05+00:00"
    evidence, _ = check._score_selector_row({
        "kind": "tls_san", "value": "example.org", "entity_count": 2,
        "a_first": row["first_seen"], "a_last": row["last_seen"],
        "b_first": row["first_seen"], "b_last": row["last_seen"],
        "a_sources": ["crtsh"], "b_sources": ["crtsh"],
    })
    assert evidence["recency"] == check._RECENCY_FLOOR


def test_ct_with_unknown_source_date_gets_minimum_freshness_credit():
    row = _ct_observation({
        "sans": ["example.org"],
        "not_before": "2026-01-01",
        "not_after": "2099-01-01",
    })
    assert row["first_seen"] is None
    assert row["last_seen"] is None
    evidence, weight = check._score_selector_row({
        "kind": "tls_san", "value": "example.org", "entity_count": 2,
        "a_first": None, "a_last": None, "b_first": None, "b_last": None,
        "a_sources": ["crtsh"], "b_sources": ["crtsh"],
    })
    assert evidence["recency"] == check._RECENCY_FLOOR
    assert evidence["degraded"] is True
    assert "CT source date is unavailable" in evidence["explanation"]
    assert weight < evidence["base_weight"]


def test_repeated_ct_san_keeps_earliest_and_latest_log_dates():
    projected = intel_db.extract_selectors({
        "input": "example.org", "timestamp": "2026-09-23T12:00:00+00:00",
        "crt_sh": {"certs": [
            {"sans": ["example.org"], "source_observed_at": "2020-01-01T00:00:00+00:00"},
            {"sans": ["example.org"], "source_observed_at": "2026-01-01T00:00:00+00:00"},
        ]},
    })
    rows = [row for row in projected["observations"] if row["kind"] == "tls_san"]
    assert len(rows) == 1
    assert rows[0]["first_seen"] == "2020-01-01T00:00:00+00:00"
    assert rows[0]["last_seen"] == "2026-01-01T00:00:00+00:00"


def test_legacy_cross_domain_san_does_not_inherit_retrieval_time():
    projected = intel_db.extract_selectors({
        "input": "example.org", "timestamp": "2026-09-23T12:00:00+00:00",
        "cert_transparency": {"cross_domain_sans": ["other.example"]},
    })
    row = next(row for row in projected["observations"] if row["kind"] == "tls_san")
    assert row["first_seen"] is None
    assert row["last_seen"] is None


def test_ct_parser_preserves_log_entry_time(monkeypatch):
    class Response:
        status_code = 200

        def json(self):
            return [{
                "id": 1, "issuer_name": "CN=Test CA", "name_value": "example.org",
                "not_before": "2019-01-01", "not_after": "2099-01-01",
                "entry_timestamp": "2020-01-02T03:04:05",
            }]

    monkeypatch.setattr(basic.requests, "get", lambda *_args, **_kwargs: Response())
    cert = basic.get_crt_sh("example.org")["certs"][0]
    assert cert["source_observed_at"] == "2020-01-02T03:04:05"
    assert cert["not_after"] == "2099-01-01"
