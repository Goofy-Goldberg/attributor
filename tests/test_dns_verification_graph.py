from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone

import psycopg

import db.intel_db as intel_db


DEFAULT_TEST_DATABASE_URL = "postgresql://intel_test:intel_test@127.0.0.1:5433/intel_test"
TEST_DATABASE_URL = os.getenv("TEST_INTEL_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


def _database_unreachable_reason() -> str | None:
    try:
        with psycopg.connect(TEST_DATABASE_URL, connect_timeout=3):
            return None
    except psycopg.Error as exc:
        return str(exc).strip() or exc.__class__.__name__


class DnsVerificationProjectionTests(unittest.TestCase):
    """DNS ownership proofs must share HTML's graph selector namespace."""

    @staticmethod
    def _project(result: dict) -> dict:
        return intel_db.extract_selectors(
            {
                "input": "example.com",
                "type": "domain",
                "timestamp": "2026-09-22T00:00:00+00:00",
                **result,
            }
        )

    def _verification_observations(self, result: dict) -> list[dict]:
        return [
            observation
            for observation in self._project(result)["observations"]
            if observation["kind"] == "site_verification"
        ]

    def test_dns_only_recognized_tokens_use_html_provider_prefixes(self) -> None:
        result = {
            "dns": {
                "TXT": [
                    "google-site-verification=AbC-123",
                    "msvalidate.01=BiNg-Code",
                ]
            }
        }
        observations = self._verification_observations(result)

        self.assertEqual(
            {(item["value"], item["source"]) for item in observations},
            {("google|AbC-123", "dns_txt"), ("bing|BiNg-Code", "dns_txt")},
        )
        # The identifiers layer remains a separate, backwards-compatible DNS
        # namespace even though the graph projection uses HTML's canonical one.
        identifiers = {
            item["id_value"]
            for item in intel_db.extract_search_identifiers(
                {"input": "example.com", "type": "domain", "timestamp": "2026-09-22T00:00:00+00:00", **result}
            )
            if item["id_type"] == "dns_txt_token"
        }
        self.assertIn("google_site_verification|AbC-123", identifiers)

    def test_equivalent_html_and_dns_proofs_share_one_selector_value(self) -> None:
        observations = self._verification_observations(
            {
                "dns": {"TXT": ["google-site-verification=MiXeD-Code"]},
                "page_metadata": {"site_verifications": {"google": ["MiXeD-Code"]}},
            }
        )

        self.assertEqual({item["value"] for item in observations}, {"google|MiXeD-Code"})
        self.assertEqual({item["source"] for item in observations}, {"dns_txt", "self_scan"})

    def test_verification_code_case_is_part_of_the_selector_identity(self) -> None:
        observations = self._verification_observations(
            {"dns": {"TXT": ["google-site-verification=Code", "google-site-verification=code"]}}
        )

        self.assertEqual({item["value"] for item in observations}, {"google|Code", "google|code"})

    def test_structured_tokens_accept_known_aliases_and_keep_unknown_identifiers_separate(self) -> None:
        result = {
            "dns": {},
            "dns_txt_tokens": [
                {"provider": "google_site_verification", "token": "AbC"},
                {"provider": "custom_verifier", "token": "MiXeD"},
            ],
            "dns_txt_verification_tokens": {
                "facebook_domain_verification": "MetaCode",
            },
        }

        self.assertEqual(
            {item["value"] for item in self._verification_observations(result)},
            {"google|AbC", "facebook|MetaCode"},
        )
        identifiers = {
            item["id_value"]
            for item in intel_db.extract_search_identifiers(
                {"input": "example.com", "type": "domain", "timestamp": "2026-09-22T00:00:00+00:00", **result}
            )
            if item["id_type"] == "dns_txt_token"
        }
        self.assertIn("custom_verifier|MiXeD", identifiers)

    def test_malformed_and_unrecognized_entries_do_not_create_site_verification_edges(self) -> None:
        observations = self._verification_observations(
            {
                "dns": {"TXT": [None, {}, "", "not-a-proof", "google-site-verification="]},
                "dns_txt_tokens": [
                    None,
                    "google_site_verification|Code",
                    {},
                    {"provider": "google_site_verification", "token": {}},
                    {"provider": "google_site_verification", "token": {"value": "Code"}},
                    {"provider": "custom_verifier", "token": "Code"},
                ],
                "dns_txt_verification_tokens": {"custom_verifier": ["Code"]},
            }
        )

        self.assertEqual(observations, [])


class DnsVerificationGraphDbTests(unittest.TestCase):
    """The persisted graph keeps one canonical selector and DNS provenance."""

    _previous_env: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        reason = _database_unreachable_reason()
        if reason is not None:
            raise unittest.SkipTest(f"PostgreSQL test database unreachable at {TEST_DATABASE_URL} ({reason})")
        cls._previous_env = os.environ.get("INTEL_DATABASE_URL")
        os.environ["INTEL_DATABASE_URL"] = TEST_DATABASE_URL

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._previous_env is None:
            os.environ.pop("INTEL_DATABASE_URL", None)
        else:
            os.environ["INTEL_DATABASE_URL"] = cls._previous_env
        intel_db.reset_schema_cache()

    def setUp(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as conn:
            for table in reversed(intel_db._ALL_TABLES):
                conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        intel_db.reset_schema_cache()
        intel_db.init_db()

    def test_dns_verification_selector_is_shared_and_keeps_dns_provenance(self) -> None:
        for domain in ("one.com", "two.com"):
            intel_db.save_search(
                {
                    "input": domain,
                    "type": "domain",
                    "timestamp": "2026-09-22T00:00:00+00:00",
                    "dns": {"TXT": ["google-site-verification=MiXeD-Code"]},
                }
            )

        with psycopg.connect(TEST_DATABASE_URL, row_factory=psycopg.rows.dict_row) as conn:
            selector = conn.execute(
                "SELECT id, entity_count FROM selectors WHERE kind = 'site_verification' AND value = %s",
                ("google|MiXeD-Code",),
            ).fetchone()
            self.assertIsNotNone(selector)
            assert selector is not None
            self.assertEqual(selector["entity_count"], 2)
            sources = {
                row["source"]
                for row in conn.execute(
                    "SELECT source FROM observations WHERE selector_id = %s", (selector["id"],)
                ).fetchall()
            }
        self.assertEqual(sources, {"dns_txt"})
        self.assertEqual(
            {row["value"] for row in intel_db.shared_selectors_between("one.com", "two.com")},
            {"google|MiXeD-Code"},
        )

    def test_dns_and_html_match_once_across_channels_without_case_collisions(self) -> None:
        from utils import check

        observed = datetime.now(timezone.utc).isoformat()
        dns = {"dns": {"TXT": ["google-site-verification=MiXeD-Code"]}}
        html = {"page_metadata": {"site_verifications": {"google": ["MiXeD-Code"]}}}
        for domain, signals in [("one.com", dns), ("two.com", html)]:
            intel_db.save_search({"input": domain, "type": "domain", "timestamp": observed, **signals})
        first = check.link_evidence("one.com", "two.com")
        self.assertEqual(first["score"], 92)
        self.assertEqual(len(first["evidence"]), 1)
        self.assertEqual(set(first["evidence"][0]["sources"]), {"dns_txt", "self_scan"})

        # Publishing the same proof in both places adds provenance, not points.
        intel_db.save_search({"input": "one.com", "type": "domain", "timestamp": observed, **dns, **html})
        repeated = check.link_evidence("one.com", "two.com")
        self.assertEqual(repeated["score"], first["score"])
        self.assertEqual(len(repeated["evidence"]), 1)

        intel_db.save_search({"input": "three.com", "type": "domain", "timestamp": observed,
                             "dns": {"TXT": ["google-site-verification=mixed-code"]}})
        self.assertEqual(check.link_evidence("one.com", "three.com")["score"], 0)


if __name__ == "__main__":
    unittest.main()
