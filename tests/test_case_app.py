from __future__ import annotations

import base64
import json
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.testclient import TestClient

import cases.case_app as case_app


def _quiet(monkeypatch, *, authenticated: bool = True) -> None:
    monkeypatch.setattr(case_app, "init_db", lambda: None)
    monkeypatch.setattr(case_app, "mark_interrupted_jobs", lambda: 0)
    monkeypatch.setattr(case_app, "healthcheck", lambda: {"status": "ok"})
    monkeypatch.setattr(case_app.runtime, "recover", lambda: None)
    # Take Redis out of the picture for every endpoint test. Without this the
    # app's lifespan warms a live cache from a live database, and the endpoint
    # then answers from that cache instead of calling the intel_db function the
    # test just monkeypatched — so the assertions run against whatever real
    # data happens to be in the pool. Nulling the client is the single lever:
    # reads, warming and invalidation all go through it, and cases.cache is
    # built to run degraded (computing live) whenever it returns None.
    monkeypatch.setattr(case_app.cache, "_redis_client", lambda: None)
    monkeypatch.setattr(case_app.intel_db, "verdict_summaries_for_pairs", lambda _pairs: {})
    if authenticated:
        async def _admin(_request):
            return {"sub": "test-admin", "role": "admin"}

        monkeypatch.setattr(case_app, "authenticate_request", _admin)


def _auth_headers(monkeypatch, *, role: str = "user", expired: bool = False, issuer: str = "http://testserver") -> dict[str, str]:
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

    async def _jwks(*, refresh=False):
        return [{"kid": "test-key", "kty": "OKP", "crv": "Ed25519", "x": base64.urlsafe_b64encode(public).rstrip(b"=").decode()}]

    monkeypatch.setenv("AUTH_ISSUER", issuer)
    monkeypatch.setattr(case_app.api_auth, "_get_jwks", _jwks)

    def _part(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()

    header = _part({"alg": "EdDSA", "kid": "test-key"})
    payload = _part({
        "iss": issuer, "aud": issuer, "sub": "test-user",
        "exp": time.time() - 1 if expired else time.time() + 900, "role": role,
    })
    signed = f"{header}.{payload}".encode()
    signature = base64.urlsafe_b64encode(key.sign(signed)).rstrip(b"=").decode()
    return {"Authorization": f"Bearer {header}.{payload}.{signature}"}


def test_api_requires_login_before_running_protected_work(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    monkeypatch.setenv("AUTH_ISSUER", "http://testserver")
    with TestClient(case_app.app) as client:
        for path in ("/api/ingest", "/api/graph/recompute", "/api/graph/email", "/api/graph/connections"):
            response = client.post(path)
            assert response.status_code == 401, path
        assert client.get("/api/pool").status_code == 401
        assert client.put("/api/verdicts", json={}).status_code == 401
        assert client.get("/api/verdicts", params={"a": "a.com", "b": "b.com"}).status_code == 401
        assert client.get("/api/verdicts/export").status_code == 401
        assert client.get("/api/jobs", params={"status": "active"}).status_code == 401
        assert client.get("/api/health").status_code == 200


def test_regular_user_can_ingest_but_cannot_email_or_recompute(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    headers = _auth_headers(monkeypatch)
    monkeypatch.setattr(case_app.runtime, "submit_case", lambda inputs, **_kwargs: {"case_id": "i", "job_id": "j"})
    monkeypatch.setattr(case_app, "get_job", lambda job_id: None)
    with TestClient(case_app.app) as client:
        assert client.post("/api/ingest", json={"target": "example.com"}, headers=headers).status_code == 202
        assert client.post("/api/graph/recompute", headers=headers).status_code == 403
        assert client.post("/api/graph/email", headers=headers).status_code == 403
        assert client.post("/api/labels/archive", json={"label": "Batch A"}, headers=headers).status_code == 403


def test_admin_token_allows_recompute_and_email(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    headers = _auth_headers(monkeypatch, role="admin")
    monkeypatch.setattr(case_app.intel_db, "rebuild_all_correlation", lambda: {"clusters": 1})
    from integrations import email_alerts
    monkeypatch.setattr(email_alerts, "email_enabled", lambda: True)
    monkeypatch.setattr(email_alerts, "send_network_graph_email", lambda png_bytes, **kwargs: True)
    with TestClient(case_app.app) as client:
        assert client.post("/api/graph/recompute", headers=headers).status_code == 200
        response = client.post("/api/graph/email", headers=headers, files={"image": ("graph.png", b"png", "image/png")})
        assert response.status_code == 200
        assert response.json()["status"] == "sent"


def test_expired_or_tampered_token_is_rejected(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    expired = _auth_headers(monkeypatch, expired=True)
    valid = _auth_headers(monkeypatch)
    valid["Authorization"] += "x"
    with TestClient(case_app.app) as client:
        assert client.get("/api/pool", headers=expired).status_code == 401
        assert client.get("/api/pool", headers=valid).status_code == 401


def test_issuer_url_with_trailing_slash_accepts_valid_token(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    headers = _auth_headers(monkeypatch, issuer="https://intel.example.org")
    monkeypatch.setenv("AUTH_ISSUER", "https://INTEL.example.org:443/")
    with TestClient(case_app.app) as client:
        assert client.get("/api/meta/evidence", headers=headers).status_code == 200


def test_auth_proxy_ignores_untrusted_forwarded_ip(monkeypatch) -> None:
    monkeypatch.delenv("AUTH_TRUSTED_PROXY_CIDRS", raising=False)
    request = Request({
        "type": "http", "client": ("203.0.113.8", 1234),
        "headers": [(b"x-forwarded-for", b"198.51.100.1")],
    })
    assert case_app._auth_client_ip(request) == "203.0.113.8"

    monkeypatch.setenv("AUTH_TRUSTED_PROXY_CIDRS", "192.0.2.10/32")
    request = Request({
        "type": "http", "client": ("192.0.2.10", 1234),
        "headers": [(b"x-forwarded-for", b"198.51.100.1, 203.0.113.8")],
    })
    assert case_app._auth_client_ip(request) == "203.0.113.8"


def test_evidence_meta_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    with TestClient(case_app.app) as client:
        response = client.get("/api/meta/evidence")
    assert response.status_code == 200
    body = response.json()
    assert any(item["type"] == "tls_certs.probes[*].fingerprint_sha256" for item in body["evidence"])


def test_gzip_middleware_is_installed() -> None:
    assert any(middleware.cls is GZipMiddleware for middleware in case_app.app.user_middleware)


def test_no_case_routes_remain() -> None:
    paths = {route.path for route in case_app.app.routes}
    assert not any(p.startswith("/api/cases") for p in paths)
    # The pool + connections surface replaces them.
    assert "/api/pool" in paths
    assert "/api/graph/connections" in paths


def test_ingest_adds_to_pool(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured: dict = {}

    def _submit(inputs, **kwargs):
        captured.update(kwargs)
        captured["count"] = len(inputs)
        return {"case_id": "ingest-1", "job_id": "job-9"}

    monkeypatch.setattr(case_app.runtime, "submit_case", _submit)
    monkeypatch.setattr(case_app, "get_job", lambda job_id: None)

    with TestClient(case_app.app) as client:
        response = client.post("/api/ingest", json={"target": "example.com", "label": "campaign-x"})

    assert response.status_code == 202
    body = response.json()
    assert body["job_id"] == "job-9"
    assert body["label"] == "campaign-x"
    assert body["accepted"] == 1
    assert captured["input_mode"] == "single"
    assert captured["label"] == "campaign-x"
    assert captured["created_by"] == "test-admin"


def test_labels_endpoint_and_repeated_pool_filter(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured = {}

    def _pool(**kwargs):
        captured.update(kwargs)
        return {"total": 1, "offset": 0, "limit": 50, "domains": [{"domain": "example.com", "labels": ["Batch A", "Batch B"]}]}

    monkeypatch.setattr(case_app.intel_db, "list_pool_domains", _pool)
    monkeypatch.setattr(case_app.intel_db, "list_channel_labels", lambda: [{"label": "Batch A", "channel_count": 2}])
    with TestClient(case_app.app) as client:
        pool = client.get("/api/pool?label=Batch+A&label=Batch+B")
        labels = client.get("/api/labels")

    assert pool.status_code == 200
    assert captured["labels"] == ["Batch A", "Batch B"]
    assert pool.json()["domains"][0]["labels"] == ["Batch A", "Batch B"]
    assert labels.json() == {"labels": [{"label": "Batch A", "channel_count": 2}]}


def test_admin_archives_label_with_verified_identity(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured = {}

    def _archive(label, *, archived_by):
        captured.update(label=label, archived_by=archived_by)
        return 2

    monkeypatch.setattr(case_app, "archive_channels_with_label", _archive)
    with TestClient(case_app.app) as client:
        response = client.post("/api/labels/archive", json={"label": " Batch A "})

    assert response.json() == {"label": "Batch A", "archived": 2}
    assert captured == {"label": "Batch A", "archived_by": "test-admin"}


def test_ingest_records_verified_creator_and_display_claim(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured: dict = {}

    async def _identity(_request):
        return {"sub": "user-42", "role": "user", "email": "analyst@stratc.org"}

    monkeypatch.setattr(case_app, "authenticate_request", _identity)
    monkeypatch.setattr(
        case_app.runtime,
        "submit_case",
        lambda _inputs, **kwargs: captured.update(kwargs) or {"case_id": "ingest-2", "job_id": "job-10"},
    )
    monkeypatch.setattr(case_app, "get_job", lambda _job_id: None)

    with TestClient(case_app.app) as client:
        response = client.post("/api/ingest", json={"target": "example.com"})

    assert response.status_code == 202
    assert captured["created_by"] == "user-42"
    assert captured["created_by_display"] == "analyst@stratc.org"


def test_jobs_endpoint_lists_active_and_recent_cards(monkeypatch) -> None:
    _quiet(monkeypatch)
    calls: list[tuple[str, int]] = []

    def _list_jobs(*, status, limit):
        calls.append((status, limit))
        return [{
            "id": f"{status}-job", "status": "running" if status == "active" else "completed",
            "stage": "enrichment", "percent": 45, "current_target": "example.com",
            "total_targets": 4, "completed_targets": 1, "failed_targets": 0,
            "label": "campaign-x", "created_by": "user-42",
            "created_by_display": "analyst@stratc.org", "created_at": "2026-09-23T09:00:00Z",
            "started_at": "2026-09-23T09:01:00Z", "finished_at": None,
            "updated_at": "2026-09-23T09:02:00Z",
        }]

    monkeypatch.setattr(case_app, "list_jobs", _list_jobs)
    with TestClient(case_app.app) as client:
        active = client.get("/api/jobs", params={"status": "active"})
        recent = client.get("/api/jobs", params={"status": "recent", "limit": 12})

    assert active.status_code == 200
    assert recent.status_code == 200
    assert calls == [("active", 5_000), ("recent", 12)]
    assert active.json()["jobs"][0]["created_by_display"] == "analyst@stratc.org"
    assert active.json()["jobs"][0]["total_targets"] == 4
    assert active.json()["jobs"][0]["completed_targets"] == 1
    assert active.json()["jobs"][0]["current_target"] == "example.com"
    assert recent.json()["jobs"][0]["label"] == "campaign-x"


def test_jobs_endpoint_rejects_unknown_status_and_invalid_limit(monkeypatch) -> None:
    _quiet(monkeypatch)
    with TestClient(case_app.app) as client:
        assert client.get("/api/jobs", params={"status": "all"}).status_code == 422
        assert client.get("/api/jobs", params={"status": "recent", "limit": 201}).status_code == 422


def test_jobs_endpoint_exposes_partial_provider_coverage(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app,
        "list_jobs",
        lambda **_kwargs: [
            {
                "id": "partial-job",
                "status": "partial",
                "stage": "notification",
                "percent": 100,
                "total_targets": 2,
                "completed_targets": 1,
                "partial_targets": 1,
                "failed_targets": 0,
                "case_summary": {
                    "provider_coverage": {
                        "providers": [
                            {"provider": "censys", "completed": 1, "failed": [], "skipped": [{"target": "followup.example", "reason": "seed-only policy"}]}
                        ]
                    }
                },
            }
        ],
    )

    with TestClient(case_app.app) as client:
        response = client.get("/api/jobs", params={"status": "recent"})

    payload = response.json()["jobs"][0]
    assert payload["status"] == "partial"
    assert payload["partial_targets"] == 1
    assert payload["provider_coverage"]["providers"][0]["skipped"][0]["target"] == "followup.example"


def test_pool_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "list_pool_domains",
        lambda **kwargs: {
            "total": 1,
            "offset": kwargs["offset"],
            "limit": kwargs["limit"],
            "domains": [
                {"domain": "a.com", "host_count": 3, "last_seen": "2026-06-01", "cluster_id": "a.com", "cluster_size": 2}
            ],
        },
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/pool")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["domains"][0]["domain"] == "a.com"


def test_pool_endpoint_passes_server_side_filters(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured: dict = {}

    def _pool(**kwargs):
        captured.update(kwargs)
        return {"total": 7, "offset": kwargs["offset"], "limit": kwargs["limit"], "domains": []}

    monkeypatch.setattr(case_app.intel_db, "list_pool_domains", _pool)
    with TestClient(case_app.app) as client:
        response = client.get(
            "/api/pool",
            params={
                "search": "alpha",
                "provenance": "ingested",
                "sort": "connections",
                "offset": 24,
                "limit": 12,
                "min_connections": 2,
                "max_connections": 20,
                "discovered_after": "2026-01-01",
                "ingested_before": "2026-06-01",
            },
        )

    assert response.status_code == 200
    assert response.json()["total"] == 7
    assert captured["search"] == "alpha"
    assert captured["provenance"] == "ingested"
    assert captured["sort"] == "connections"
    assert captured["offset"] == 24
    assert captured["limit"] == 12
    assert captured["min_connections"] == 2
    assert captured["max_connections"] == 20
    assert captured["discovered_after"] == "2026-01-01"
    assert captured["ingested_before"] == "2026-06-01"
    assert captured["include_total"] is True


def test_domain_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "domain_profile",
        lambda value: {"domain": value, "hosts": [{"value": value, "kind": "domain"}],
                       "ips": [], "selectors": [], "intel": {"dns": {"A": ["1.2.3.4"]}}},
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/domain/lonely.com")
    assert response.status_code == 200
    assert response.json()["intel"]["dns"]["A"] == ["1.2.3.4"]


def test_domain_endpoint_404(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(case_app.intel_db, "domain_profile", lambda value: None)
    with TestClient(case_app.app) as client:
        response = client.get("/api/domain/nope.example")
    assert response.status_code == 404


def test_connections_among_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(case_app.intel_db, "verdict_summaries_for_pairs", lambda pairs: {
        ("a.com", "b.com"): {
            "counts": {"same_owner": 2, "different_owner": 1, "unsure": 0}, "verdicts": [],
        },
        ("a.com", "c.com"): {
            "counts": {"same_owner": 0, "different_owner": 1, "unsure": 0}, "verdicts": [],
        },
    })
    captured: dict = {}

    def _connections(domains, *, pool_links=False, **_):
        captured["domains"] = domains
        captured["pool_links"] = pool_links
        return {
            "domains": domains,
            "pairs": [{"a": "a.com", "b": "b.com", "score": 82.0, "connected": True, "evidence": []}],
            "pool_links": {"a.com": [{"target": "c.com", "score": 40.0, "evidence": []}]} if pool_links else {},
            "connected_pair_count": 1,
        }

    monkeypatch.setattr(case_app.check, "connections_among", _connections)
    with TestClient(case_app.app) as client:
        response = client.post("/api/graph/connections", json={"domains": ["a.com", "b.com"]})
    assert response.status_code == 200
    body = response.json()
    assert body["connected_pair_count"] == 1
    assert captured["domains"] == ["a.com", "b.com"]
    assert body["pairs"][0]["verdict_summary"]["counts"] == {
        "same_owner": 2, "different_owner": 1, "unsure": 0,
    }
    with TestClient(case_app.app) as client:
        pool_response = client.post("/api/graph/connections", json={"domains": ["a.com", "b.com"], "pool_links": True})
    assert pool_response.status_code == 200
    assert pool_response.json()["pool_links"]["a.com"][0]["verdict_summary"]["counts"]["different_owner"] == 1


def test_connections_requires_domains(monkeypatch) -> None:
    _quiet(monkeypatch)
    with TestClient(case_app.app) as client:
        response = client.post("/api/graph/connections", json={"domains": []})
    assert response.status_code == 400


def test_by_selector_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "domains_by_selector",
        lambda *, kind, min_domains, limit: [
            {"kind": "tls_cert_sha256", "value": "abc", "degree": 2, "domains": ["a.com", "b.com"]}
        ],
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/by-selector", params={"kind": "tls_cert_sha256"})
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "tls_cert_sha256"
    assert body["groups"][0]["domains"] == ["a.com", "b.com"]


def test_selector_kinds_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "selector_kind_counts",
        lambda *, min_domains: [{"kind": "tls_cert_sha256", "groups": 5}, {"kind": "shared_ip", "groups": 3}],
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/selector-kinds")
    assert response.status_code == 200
    assert response.json()["kinds"][0]["kind"] == "tls_cert_sha256"


def test_graph_links_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(case_app.intel_db, "verdict_summaries_for_pairs", lambda pairs: {
        ("a.com", "b.com"): {
            "counts": {"same_owner": 2, "different_owner": 1, "unsure": 0}, "verdicts": [],
        }
    })
    monkeypatch.setattr(
        case_app.cache,
        "graph_links",
        lambda value, *, limit: {
            "links": [
            {"target": "b.com", "score": 100.0, "strength": "strong",
             "evidence": [{"kind": "tls_cert_sha256", "value": "abc", "degree": 2, "weight": 100.0}]}
            ],
            "total": 51,
            "limit": limit,
            "has_more": True,
        },
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/links/a.com")
    assert response.status_code == 200
    body = response.json()
    assert body["target"] == "a.com"
    assert body["total"] == 51
    assert body["limit"] == 50
    assert body["has_more"] is True
    assert body["links"][0]["target"] == "b.com"
    assert body["links"][0]["verdict_summary"]["counts"]["same_owner"] == 2


def test_verdict_routes_use_verified_identity_and_server_score(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    headers = _auth_headers(monkeypatch)
    captured = {}
    summary = {"counts": {"same_owner": 1, "different_owner": 0, "unsure": 0}, "verdicts": []}
    monkeypatch.setattr(case_app.check, "link_evidence", lambda a, b: {
        "score": 42.5, "strength": "moderate", "evidence": [{"kind": "shared_ip"}],
    })

    def _record(a, b, verdict, note, user_id, user_display, link):
        captured.update(a=a, b=b, verdict=verdict, note=note, user_id=user_id,
                        user_display=user_display, link=link)
        return {"id": 1, "verdict": verdict}

    monkeypatch.setattr(case_app.intel_db, "record_pair_verdict", _record)
    monkeypatch.setattr(case_app.intel_db, "verdict_summaries_for_pairs", lambda pairs: {("a.com", "b.com"): summary})
    monkeypatch.setattr(case_app.intel_db, "verdict_summaries_for_domain", lambda domain: [
        {"a": "a.com", "b": "b.com", "verdict_summary": summary}
    ])
    with TestClient(case_app.app) as client:
        response = client.put("/api/verdicts", headers=headers, json={
            "a": "WWW.B.COM", "b": "a.com", "verdict": "same_owner", "note": "  legal page  ",
            "score": 9999, "evidence_kinds": ["made_up"],
        })
        pair = client.get("/api/verdicts", headers=headers, params={"a": "b.com", "b": "a.com"})
        domain = client.get("/api/verdicts", headers=headers, params={"domain": "www.b.com"})
    assert response.status_code == 200
    assert captured == {
        "a": "a.com", "b": "b.com", "verdict": "same_owner", "note": "legal page",
        "user_id": "test-user", "user_display": None,
        "link": {"score": 42.5, "strength": "moderate", "evidence": [{"kind": "shared_ip"}]},
    }
    assert pair.json()["counts"]["same_owner"] == 1
    assert domain.json()["pairs"][0]["verdict_summary"] == summary


def test_verdict_export_requires_admin_and_includes_snapshots(monkeypatch) -> None:
    _quiet(monkeypatch, authenticated=False)
    user_headers = _auth_headers(monkeypatch)
    monkeypatch.setattr(case_app.intel_db, "export_pair_verdicts", lambda: [{
        "id": 7, "a": "a.com", "b": "b.com", "verdict": "different_owner",
        "note": "=1+1", "user_id": "analyst-1", "user_display": "A",
        "created_at": "2026-09-23T12:00:00+00:00", "score": 40.0,
        "strength": "moderate", "evidence_kinds": ["shared_ip", "tls_spki"],
    }])
    with TestClient(case_app.app) as client:
        assert client.get("/api/verdicts/export", headers=user_headers).status_code == 403
        admin_headers = _auth_headers(monkeypatch, role="admin")
        response = client.get("/api/verdicts/export", headers=admin_headers)
        csv_response = client.get("/api/verdicts/export", headers=admin_headers, params={"format": "csv"})
    assert response.status_code == 200
    assert response.json()["verdicts"][0]["score"] == 40.0
    assert csv_response.status_code == 200
    assert '"[""shared_ip"", ""tls_spki""]"' in csv_response.text
    assert "'=1+1" in csv_response.text


def test_verdict_rejects_same_channel_and_invalid_values(monkeypatch) -> None:
    _quiet(monkeypatch)
    with TestClient(case_app.app) as client:
        assert client.put("/api/verdicts", json={"a": "www.a.com", "b": "a.com", "verdict": "unsure"}).status_code == 400
        assert client.put("/api/verdicts", json={"a": "a.com", "b": "b.com", "verdict": "maybe"}).status_code == 400
        assert client.put("/api/verdicts", json={"a": "a.com", "b": "b.com", "verdict": ["unsure"]}).status_code == 400
        assert client.get("/api/verdicts", params={"domain": "https://a.com"}).status_code == 400
        assert client.get("/api/verdicts", params={"domain": "co.uk"}).status_code == 400


def test_graph_link_pair_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(case_app.check, "link_evidence", lambda a, b: {"a": a, "b": b, "score": 80.0, "evidence": []})
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/link", params={"a": "a.com", "b": "b.com"})
    assert response.status_code == 200
    assert response.json()["link"]["a"] == "a.com"


def test_graph_path_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "path_between",
        lambda a, b: {"a": a, "b": b, "hops": 2, "chain": [
            {"from": "a.com", "to": "b.com", "score": 90.0, "evidence": []},
            {"from": "b.com", "to": "c.com", "score": 85.0, "evidence": []},
        ]},
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/path", params={"a": "a.com", "b": "c.com"})
    assert response.status_code == 200
    body = response.json()
    assert body["path"]["hops"] == 2
    assert body["path"]["chain"][0]["to"] == "b.com"


def test_graph_path_endpoint_404_when_unreachable(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(case_app.intel_db, "path_between", lambda a, b: None)
    monkeypatch.setattr(case_app.intel_db, "path_status_for", lambda value: {
        "partial": True, "stale": False,
    })
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/path", params={"a": "a.com", "b": "z.com"})
    assert response.status_code == 404


def test_graph_path_requires_both_params(monkeypatch) -> None:
    _quiet(monkeypatch)
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/path", params={"a": "a.com"})
    assert response.status_code == 422  # FastAPI's own required-query-param validation


def test_graph_related_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "related_through_page",
        lambda value, *, max_hops, limit: {
            "related": [{"target": "b.com", "hops": 1, "min_hop_score": 90.0, "chain": []}],
            "total": 61, "limit": limit, "has_more": True,
            "path_limits": {"max_hops": 3, "partial": True}, "partial": True, "stale": False,
        },
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/related/a.com")
    assert response.status_code == 200
    body = response.json()
    assert body["target"] == "a.com"
    assert body["total"] == 61
    assert body["has_more"] is True
    assert body["partial"] is True
    assert body["related"][0]["target"] == "b.com"


def test_graph_related_can_page_indirect_paths_only(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured = {}

    def page(value, **kwargs):
        captured.update(kwargs)
        return {"related": [], "total": 0, "limit": kwargs["limit"], "has_more": False, "partial": False, "stale": False}

    monkeypatch.setattr(case_app.intel_db, "related_through_page", page)
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/related/a.com?min_hops=2")
    assert response.status_code == 200
    assert captured["min_hops"] == 2


def test_search_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    captured: dict = {}

    def _search(q, *, limit):
        captured["q"] = q
        captured["limit"] = limit
        return {"query": q, "domains": [{"domain": "a.com", "connection_count": 2, "cluster_id": None, "tier": None}], "selectors": []}

    monkeypatch.setattr(case_app.intel_db, "search_targets", _search)
    with TestClient(case_app.app) as client:
        response = client.get("/api/search", params={"q": "a.co", "limit": 5})
    assert response.status_code == 200
    body = response.json()
    assert body["domains"][0]["domain"] == "a.com"
    assert captured["q"] == "a.co"
    assert captured["limit"] == 5


def test_graph_clusters_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(
        case_app.intel_db,
        "list_graph_clusters",
        lambda *, min_size, limit: [{"cluster_id": "a.com", "component_size": 2, "members": ["a.com", "b.com"]}],
    )
    with TestClient(case_app.app) as client:
        response = client.get("/api/graph/clusters")
    assert response.status_code == 200
    assert response.json()["clusters"][0]["members"] == ["a.com", "b.com"]


def test_graph_recompute_endpoint(monkeypatch) -> None:
    _quiet(monkeypatch)
    monkeypatch.setattr(case_app.intel_db, "rebuild_all_correlation", lambda: {"searches": 3, "clusters": 1})
    with TestClient(case_app.app) as client:
        response = client.post("/api/graph/recompute")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "recomputed"
    assert body["searches"] == 3
