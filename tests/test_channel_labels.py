from __future__ import annotations

import os

import psycopg
import pytest

from cases import case_store
from db import intel_db


@pytest.mark.skipif(not os.getenv("TEST_CHANNEL_LABEL_DATABASE_URL"), reason="isolated PostgreSQL test database required")
def test_channel_labels_survive_rescans_and_backfill_legacy_modes(monkeypatch) -> None:
    url = os.environ["TEST_CHANNEL_LABEL_DATABASE_URL"]
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("INTEL_DATABASE_URL", url)
    intel_db.reset_schema_cache()
    try:
        case_store.init_db()
        intel_db.init_db()

        def _input(host: str) -> dict:
            return {
                "input_value": host,
                "normalized_target": host,
                "target_type": "domain",
                "source": "single",
            }

        with psycopg.connect(url) as conn:
            conn.execute("""
                INSERT INTO entities (kind, value, registrable_domain, first_seen, last_seen)
                VALUES ('domain', 'example.com', 'example.com', '2026-01-01', '2026-01-01'),
                       ('domain', 'example.org', 'example.org', '2026-01-01', '2026-01-01')
            """)

        first = case_store.create_case(
            [_input("www.example.com"), _input("example.org")],
            input_mode="manual_urls", label="UI redesign test", created_by="analyst-1",
        )
        case_store.create_case(
            [_input("example.com")], input_mode="single",
            label="Follow-up", created_by="analyst-2",
        )
        case_store.create_case([_input("example.org")], input_mode="csv")
        case_store.create_case([_input("news.example.org")], input_mode="Old batch")

        with psycopg.connect(url) as conn:
            conn.execute("DELETE FROM app_migrations WHERE name = 'channel_labels_backfill'")
        case_store.init_db()

        with psycopg.connect(url) as conn:
            rows = conn.execute("""
                SELECT registrable_domain, label, job_id, added_by, added_at
                FROM channel_labels ORDER BY registrable_domain, label
            """).fetchall()
        assert [(row[0], row[1], row[3]) for row in rows] == [
            ("example.com", "Follow-up", "analyst-2"),
            ("example.com", "UI redesign test", "analyst-1"),
            ("example.org", "Old batch", None),
            ("example.org", "UI redesign test", "analyst-1"),
        ]
        assert all(row[4] is not None for row in rows)
        assert first["job_id"] in {row[2] for row in rows}

        pool = intel_db.list_pool_domains(labels=["UI redesign test"], include_total=True)
        assert pool["total"] == 2
        assert {row["domain"] for row in pool["domains"]} == {"example.com", "example.org"}
        assert intel_db.list_pool_domains(labels=["Follow-up"], include_total=True)["total"] == 1
        assert intel_db.list_channel_labels() == [
            {"label": "Follow-up", "channel_count": 1},
            {"label": "Old batch", "channel_count": 1},
            {"label": "UI redesign test", "channel_count": 2},
        ]
        assert intel_db.domain_profile("example.com")["labels"] == ["Follow-up", "UI redesign test"]
        assert case_store.archive_channels_with_label("Follow-up", archived_by="admin-1") == 1
        assert intel_db.list_pool_domains(include_total=True)["total"] == 1
        assert intel_db.domain_profile("example.com")["archived"] is True
        assert intel_db.list_channel_labels() == [
            {"label": "Old batch", "channel_count": 1},
            {"label": "UI redesign test", "channel_count": 1},
        ]
    finally:
        intel_db.reset_schema_cache()
