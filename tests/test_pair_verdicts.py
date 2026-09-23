from __future__ import annotations

import os

import psycopg
import pytest

from db import intel_db


TEST_DATABASE_URL = os.getenv(
    "TEST_INTEL_DATABASE_URL", "postgresql://intel_test:intel_test@127.0.0.1:5433/intel_test"
)


def test_verdict_history_latest_per_user_and_score_snapshots(monkeypatch) -> None:
    try:
        with psycopg.connect(TEST_DATABASE_URL, connect_timeout=3):
            pass
    except psycopg.Error as exc:
        pytest.skip(f"PostgreSQL test database unavailable: {exc}")

    monkeypatch.setenv("INTEL_DATABASE_URL", TEST_DATABASE_URL)
    intel_db.reset_schema_cache()
    intel_db.init_db()
    with psycopg.connect(TEST_DATABASE_URL) as conn:
        conn.execute("TRUNCATE pair_verdicts RESTART IDENTITY")

    first = intel_db.record_pair_verdict(
        "news.beta.com", "alpha.com", "same_owner", "Shared operator", "user-1", "Analyst 1",
        {"score": 73.25, "strength": "strong", "evidence": [{"kind": "tls_spki"}, {"kind": "tls_spki"}]},
    )
    second = intel_db.record_pair_verdict(
        "alpha.com", "beta.com", "different_owner", "New research", "user-1", "Analyst 1",
        {"score": 15, "strength": "weak", "evidence": [{"kind": "shared_ip"}]},
    )
    intel_db.record_pair_verdict(
        "beta.com", "alpha.com", "unsure", None, "user-2", "Analyst 2",
        {"score": 15, "strength": "weak", "evidence": []},
    )

    assert first["a"] == "alpha.com" and first["b"] == "beta.com"
    assert first["evidence_kinds"] == ["tls_spki"]
    assert second["score"] == 15
    summary = intel_db.verdict_summaries_for_pairs([("beta.com", "alpha.com")])[("alpha.com", "beta.com")]
    assert summary["counts"] == {"different_owner": 1, "same_owner": 0, "unsure": 1}
    assert {row["id"] for row in summary["verdicts"]} == {second["id"], second["id"] + 1}
    assert len(intel_db.verdict_summaries_for_domain("alpha.com")) == 1
    history = intel_db.export_pair_verdicts()
    assert len(history) == 3
    assert history[0]["score"] == 73.25
    assert history[0]["evidence_kinds"] == ["tls_spki"]
    intel_db.reset_schema_cache()
