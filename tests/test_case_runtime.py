from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from core import basic
from core import analysis_service
from core.analysis_service import AnalysisRun, _merge_page_metadata
from cases.case_runtime import (
    CaseRuntime,
    build_job_response,
    parse_submission,
)
from cases import case_runtime


def test_basic_runtime_hooks_are_context_local() -> None:
    def _run(label: str) -> list[tuple[str, str, object]]:
        events: list[tuple[str, str, object]] = []

        def _log(message: str, level: str = "*") -> None:
            events.append((label, level, message))

        def _save(results: dict) -> None:
            events.append((label, "save", results["label"]))

        with basic.runtime_hooks(log_hook=_log, save_hook=_save):
            basic.log(f"log-{label}", "+")
            basic.save_results({"label": label})
        return events

    with ThreadPoolExecutor(max_workers=2) as executor:
        left, right = executor.map(_run, ["left", "right"])

    assert left == [("left", "+", "log-left"), ("left", "save", "left")]
    assert right == [("right", "+", "log-right"), ("right", "save", "right")]


def test_parse_submission_single_target() -> None:
    inputs, mode = parse_submission(target="https://Example.com/")
    assert mode == "single"
    assert len(inputs) == 1
    assert inputs[0]["normalized_target"] == "example.com"
    assert inputs[0]["target_type"] == "domain"


def test_parse_submission_csv_deduplicates_first_column() -> None:
    csv_content = b"example.com,ignored\nhttps://example.com/\n1.1.1.1\n"
    inputs, mode = parse_submission(csv_content=csv_content)
    assert mode == "csv"
    assert [item["normalized_target"] for item in inputs] == ["example.com", "1.1.1.1"]


def test_build_job_response_exposes_stage_and_steps() -> None:
    payload = build_job_response(
        {
            "job_id": "job-1",
            "job_status": "running",
            "job_stage": "comparison",
            "job_percent": 80,
            "completed_targets": 3,
            "failed_targets": 1,
            "total_targets": 5,
            "current_target": "alpha.example",
            "logs": [{"level": "info", "message": "hello"}],
        }
    )
    assert payload["id"] == "job-1"
    assert payload["status"] == "running"
    assert payload["stage"] == "comparison"
    assert payload["steps"][2]["status"] == "running"
    assert payload["failed_targets"] == 1


def test_build_job_response_exposes_partial_provider_coverage() -> None:
    payload = build_job_response(
        {
            "id": "job-coverage",
            "status": "partial",
            "stage": "notification",
            "percent": 100,
            "completed_targets": 1,
            "partial_targets": 2,
            "failed_targets": 1,
            "total_targets": 4,
            "case_summary": {
                "provider_coverage": {
                    "providers": [
                        {"provider": "censys", "completed": 1, "failed": [], "skipped": [{"target": "followup.example", "reason": "policy"}]}
                    ]
                },
                "target_outcomes": [{"target": "followup.example", "status": "partial"}],
            },
        }
    )
    assert payload["status"] == "partial"
    assert payload["partial_targets"] == 2
    assert payload["provider_coverage"]["providers"][0]["provider"] == "censys"
    assert payload["target_outcomes"][0]["status"] == "partial"
    assert "partial" in payload["summary"]


def test_analyze_target_marks_skipped_provider_coverage_partial(monkeypatch) -> None:
    source_results = {name: {} for name, _service in basic.SERVICES} | {"domain": "example.com"}
    source_results["censys"] = {"skipped": True, "reason": "seed-only policy"}
    source_results["urlscan"] = {"error": "rate limited"}
    monkeypatch.setattr(analysis_service, "_analyze_domain", lambda *_args, **_kwargs: source_results)
    monkeypatch.setattr("db.intel_db.save_search", lambda _payload: "search-1")

    run = analysis_service.analyze_target(
        "example.com",
        depth=1,
        discovered_from="seed.example",
        discovery_reason="follow-up",
        discovery_kind="subdomain_followup",
        is_seed=False,
    )

    assert run.status == "partial"
    assert run.payload["persistence"] == {"status": "saved", "search_id": "search-1"}
    assert run.payload["provider_coverage"]["counts"] == {"completed": len(basic.SERVICES) - 2, "failed": 1, "skipped": 2}
    assert run.payload["provider_coverage"]["failed"] == [{"provider": "urlscan", "error": "rate limited"}]


def test_provider_coverage_includes_supplemental_and_ip_enrichment_outcomes() -> None:
    payload = {name: {} for name, _service in basic.SERVICES}
    payload.update({
        "collector_failures": [{"provider": "legal pages", "error": "request timed out"}],
        "non_cf_ips": ["1.1.1.1", "8.8.8.8", "8.8.4.4"],
        "ip_enrichment_candidates": ["1.1.1.1", "8.8.8.8"],
        "ip_details": {"1.1.1.1": {"asn_info": {
            "ipinfo": {"skipped": True, "reason": "IP_INFO_KEY missing"},
            "censys_enrichment": {"error": "quota exhausted"},
        }}},
    })
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert coverage["status"] == "partial"
    assert {item["provider"] for item in coverage["failed"]} == {
        "legal pages", "censys_host_enrichment:1.1.1.1", "ip_enrichment:8.8.8.8",
    }
    assert {item["provider"] for item in coverage["skipped"]} == {
        "censys_reverse_lookup", "ipinfo_lite:1.1.1.1",
    }


def test_provider_coverage_identifies_successful_ct_fallback() -> None:
    payload = {name: {} for name, _service in basic.SERVICES}
    payload["crt_sh"] = {"source": "certspotter", "certs": []}
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert "certspotter" in coverage["completed"]
    assert {item["provider"] for item in coverage["failed"]} == {"crt_sh"}


def test_provider_coverage_flags_homepage_outage_but_not_missing_page() -> None:
    payload = {name: {} for name, _service in basic.SERVICES}
    payload["page_metadata"] = {"status_code": 503, "error": None}
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert {item["provider"] for item in coverage["failed"]} == {"page_metadata"}
    payload["page_metadata"] = {"status_code": 404, "error": None}
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert not coverage["failed"]


def test_dns_timeout_is_reported_but_no_answer_is_not(monkeypatch) -> None:
    class Resolver:
        def resolve(self, _domain, rtype):
            if rtype == "A":
                raise basic.dns.exception.Timeout("resolver timed out")
            raise basic.dns.resolver.NoAnswer()

    monkeypatch.setattr(basic, "_build_resolver", lambda **_kwargs: Resolver())
    dns_result = basic.get_dns("example.org")
    assert "A" in dns_result["_errors"]
    assert "AAAA" not in dns_result["_errors"]
    payload = {name: {} for name, _service in basic.SERVICES}
    payload["dns"] = dns_result
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert {item["provider"] for item in coverage["failed"]} == {"dns"}


def test_provider_coverage_uses_returned_collector_errors() -> None:
    payload = {name: {} for name, _service in basic.SERVICES}
    payload.update({
        "legal_pages": {"pages": [
            {"path": "/impressum", "error": "request timed out"},
            {"path": "/about", "status_code": 404, "error": None},
            {"path": "/legal", "status_code": 503, "error": None},
        ]},
        "well_known": {"raw": {
            "security_txt": {"found": False, "attempts": [{"error": "connection failed"}]},
            "ads_txt": {"found": False, "attempts": [{"status_code": 404, "error": None}]},
            "mta_sts_txt": {"found": False, "attempts": [{"status_code": 429, "error": None}]},
        }},
        "microsoft_tenant": {"results": [
            {"url": "https://login.microsoftonline.com/example.org", "ok": False, "error": "connection timed out"},
            {"url": "https://login.windows.net/example.org", "ok": False, "status_code": 404, "error": "unexpected_status"},
            {"url": "https://login.microsoftonline.com/example.org/v2", "ok": False, "status_code": 503, "error": "unexpected_status"},
            {"url": "https://login.microsoftonline.com/no-tenant.example", "ok": False, "status_code": 400, "error": "unexpected_status", "error_code": "AADSTS90002"},
        ]},
        "mail_client_config": {
            "autodiscover": [
                {"label": "subdomain", "error": "host not found", "missing_host": True},
                {"label": "root", "status_code": 503, "error": None},
            ],
            "autoconfig": [{"label": "well_known", "status_code": 404, "error": None}],
        },
        "source_map_disclosures": {"scripts": [
            {"url": "https://example.org/app.js", "status_code": 503, "error": None},
        ]},
        "email_security": {"spf_errors": [
            {"domain": "_spf.example.org", "error": "resolver timed out"},
            {"domain": "deep.example.org", "error": "max_depth_exceeded"},
        ]},
    })
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert {item["provider"] for item in coverage["failed"]} == {
        "legal_pages:/impressum", "legal_pages:/legal", "well_known:security_txt", "well_known:mta_sts_txt", "microsoft_tenant",
        "mail_client_config:autodiscover:root",
        "source_map_disclosures",
        "spf:_spf.example.org",
    }
    assert any(item["provider"] == "spf:deep.example.org" for item in coverage["skipped"])
    assert any("HTTP 503" in item["error"] for item in coverage["failed"])
    assert analysis_service._collect_source_map_urls({"scripts": [
        {"source_map_urls": ["https://example.org/app.js.map"]},
    ]}) == ["https://example.org/app.js.map"]


def test_provider_coverage_includes_reverse_lookup_selector_failures() -> None:
    payload = {name: {} for name, _service in basic.SERVICES}
    payload["censys_reverse_lookup"] = {"selectors": [
        {"kind": "tracking_id", "error": "quota exceeded", "global_hits": None},
        {"kind": "favicon", "error": "permission denied", "global_hits": None},
    ]}
    coverage = analysis_service.provider_coverage(payload, target_type="domain")
    assert coverage["status"] == "partial"
    assert coverage["counts"]["failed"] == 2
    assert "censys_reverse_lookup" not in coverage["completed"]


def test_raised_target_failure_is_in_durable_job_outcomes(monkeypatch) -> None:
    monkeypatch.setattr(case_runtime, "mark_case_started", lambda *_args: None)
    monkeypatch.setattr(case_runtime, "load_case_inputs", lambda *_args: [{"normalized_target": "example.org"}])
    monkeypatch.setattr(case_runtime, "update_job_progress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(case_runtime, "analyze_target", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("scan crashed")))
    saved = []
    completed = []
    monkeypatch.setattr(case_runtime, "save_search_run", lambda *_args, **kwargs: saved.append(kwargs) or 7)
    monkeypatch.setattr(case_runtime, "complete_case", lambda *_args, **kwargs: completed.append(kwargs))
    monkeypatch.setattr(case_runtime, "get_case", lambda *_args: None)
    monkeypatch.setattr(case_runtime, "get_job", lambda *_args: None)
    runtime = CaseRuntime()
    monkeypatch.setattr(runtime, "_log", lambda *_args, **_kwargs: None)
    try:
        runtime._run_case("case-1", "job-1")
    finally:
        runtime._executor.shutdown(wait=False)

    assert saved[0]["status"] == "failed"
    assert saved[0]["error"] == "scan crashed"
    assert completed[0]["status"] == "failed"
    assert completed[0]["summary"]["target_outcomes"][0]["target"] == "example.org"
    assert completed[0]["summary"]["target_outcomes"][0]["status"] == "failed"
    assert completed[0]["summary"]["provider_coverage"]["target_counts"]["failed"] == 1


def test_analyze_target_marks_intel_store_failure_failed_but_keeps_payload(monkeypatch) -> None:
    source_results = {name: {} for name, _service in basic.SERVICES} | {"domain": "example.com"}
    calls: list[str] = []

    def _analyze_once(domain, **_kwargs):
        calls.append(domain)
        return source_results

    monkeypatch.setattr(analysis_service, "_analyze_domain", _analyze_once)

    def _fail_save(_payload):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("db.intel_db.save_search", _fail_save)

    run = analysis_service.analyze_target(
        "example.com",
        depth=0,
        discovered_from=None,
        discovery_reason="submitted input",
        discovery_kind="seed",
        is_seed=True,
    )

    assert run.status == "failed"
    assert "database unavailable" in (run.error or "")
    assert run.payload["persistence"]["status"] == "failed"
    assert run.payload["domain"] == "example.com"
    assert calls == ["example.com"]  # persistence failure never re-runs providers


def test_reverse_lookup_projection_failure_does_not_erase_saved_scan(monkeypatch) -> None:
    source_results = {name: {} for name, _service in basic.SERVICES} | {
        "domain": "example.com",
        "censys_reverse_lookup": {"selectors": ["identifier"]},
    }
    monkeypatch.setattr(analysis_service, "_analyze_domain", lambda *_args, **_kwargs: source_results)
    monkeypatch.setattr(analysis_service, "_reverse_lookup", lambda *_args, **_kwargs: {"selectors": ["identifier"]})
    monkeypatch.setattr("db.intel_db.save_search", lambda _payload: 42)

    def fail_projection(*_args):
        raise RuntimeError("reverse lookup unavailable")

    monkeypatch.setattr("db.discovery_store.record_reverse_lookup", fail_projection)
    run = analysis_service.analyze_target(
        "example.com", depth=0, discovered_from=None, discovery_reason=None,
        discovery_kind="seed", is_seed=True,
    )
    assert run.status == "partial"
    assert run.payload["persistence"]["status"] == "saved"
    assert run.payload["persistence"]["search_id"] == "42"
    assert "reverse lookup unavailable" in (run.error or "")


def test_build_pool_summary_ranks_findings_from_pool_links(monkeypatch) -> None:
    def _fake_links_for(value, limit=3):
        if value == "alpha.example":
            return [
                {"target": "beta.example", "score": 72, "confidence": 60, "strength": "strong"},
                {"target": "gamma.example", "score": 12, "confidence": 15, "strength": "weak"},
            ]
        return []

    monkeypatch.setattr("cases.case_runtime.check.links_for", _fake_links_for)

    runtime = CaseRuntime()
    runs = [
        {
            "id": "run-a",
            "analysis": AnalysisRun(
                target="alpha.example",
                normalized_target="alpha.example",
                target_type="domain",
                depth=0,
                discovered_from=None,
                discovery_reason=None,
                discovery_kind=None,
                is_seed=True,
                payload={"domain": "alpha.example", "comparison_labels": {"display": "alpha.example"}},
            ),
        },
        {
            "id": "run-b",
            "analysis": AnalysisRun(
                target="vpn.alpha.example",
                normalized_target="vpn.alpha.example",
                target_type="domain",
                depth=1,
                discovered_from="alpha.example",
                discovery_reason="follow-up subdomain leak",
                discovery_kind="subdomain_followup",
                is_seed=False,
                payload={"domain": "vpn.alpha.example", "comparison_labels": {"display": "vpn.alpha.example"}},
            ),
        },
    ]

    summary = runtime._build_pool_summary(runs)

    assert summary["target_count"] == 1  # only the seed, not the follow-up subdomain
    assert summary["run_count"] == 2
    assert [f["linked_target"] for f in summary["top_findings"]] == ["beta.example", "gamma.example"]
    assert summary["highlights"][0] == "alpha.example ↔ beta.example (score 72)"


def test_merge_page_metadata_handles_list_entries_with_dicts() -> None:
    merged = _merge_page_metadata(
        {
            "script_assets": [{"src": "https://example.com/app.js"}],
            "google_analytics": ["G-BASE"],
        },
        {
            "script_assets": [
                {"src": "https://example.com/app.js"},
                {"src": "https://example.com/runtime.js"},
            ],
            "google_analytics": ["G-BASE", "G-EXTRA"],
        },
    )

    assert merged["script_assets"] == [
        {"src": "https://example.com/app.js"},
        {"src": "https://example.com/runtime.js"},
    ]
    assert merged["google_analytics"] == ["G-BASE", "G-EXTRA"]
