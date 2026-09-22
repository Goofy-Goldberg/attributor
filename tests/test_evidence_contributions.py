"""Regression checks for redundant measurements inflating a relationship."""

from utils import check


def row(kind, value, degree=2):
    return {"kind": kind, "value": value, "entity_count": degree}


def link(*rows):
    return check._assemble_link(list(rows), [], ip_meta={}, cert_meta={})


def test_two_hashes_of_a_favicon_do_not_create_a_strong_link():
    result = link(row("favicon_md5", "abc"), row("favicon_mmh3", "123"))
    assert result["score"] == 45
    assert result["strength"] == "moderate"
    assert result["shared_node_count"] == 2
    assert [e["weight"] for e in result["evidence"]] == [45, 0]
    assert all(e["scoring_note"] for e in result["evidence"])
    assert sum(e["weight"] for e in result["evidence"]) == result["score"]


def test_tls_certificate_key_and_names_are_not_independent_confirmations():
    result = link(row("tls_cert_sha256", "abc"), row("tls_spki", "def"), row("tls_san", "example.com"))
    assert result["score"] == 200
    assert result["confidence"] == check.confidence_from_score(200)
    assert len(result["evidence"]) == 3
    assert sum(e["weight"] > 0 for e in result["evidence"]) == 1


def test_group_uses_adjusted_contribution_not_largest_base_weight():
    result = link(row("tls_cert_sha256", "abc", degree=100), row("tls_spki", "def"))
    assert result["score"] == 80
    assert result["evidence"][0]["kind"] == "tls_spki"
    assert result["evidence"][1]["raw_weight"] > 0
    assert result["evidence"][1]["weight"] == 0


def test_distinct_families_and_account_identifiers_still_contribute():
    result = link(row("favicon_md5", "abc"), row("favicon_mmh3", "123"),
                  row("tls_cert_sha256", "def"), row("tracking_id", "gtm_container|GTM-X"))
    assert result["score"] == 45 + 200 + 45


def test_single_match_is_unchanged_and_has_no_duplicate_note():
    result = link(row("favicon_md5", "abc"))
    assert result["score"] == 40
    assert "scoring_note" not in result["evidence"][0]


def test_repeated_family_and_tie_break_are_order_independent():
    rows = [row("tls_cert_sha256", "b"), row("tls_cert_sha256", "a")]
    forward, reverse = link(*rows), link(*reversed(rows))
    assert forward == reverse
    assert forward["score"] == 200
    assert forward["evidence"][0]["value"] == "a"


def test_legacy_dns_alias_deduplication_preserves_token_case():
    dns = row("dns_txt_token", "google_site_verification|AbC")
    same = row("site_verification", "google|AbC")
    different = row("site_verification", "google|abc")
    assert check._dedupe_verification_tokens([same, dns, different]) == [dns, different]
