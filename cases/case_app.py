from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import csv
import hashlib
from ipaddress import ip_address, ip_network
from io import StringIO
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from cases.case_runtime import CaseRuntime, build_job_response, parse_submission
from cases import auth as api_auth
from core.analysis_service import normalize_inputs
from cases.case_store import archive_channels_with_label, get_job, healthcheck, init_db, list_jobs, mark_interrupted_jobs
from cases import cache
from utils.evidence_meta import evidence_catalog
from utils import check
from db import intel_db
from sources import signal_web


BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
runtime = CaseRuntime()
LOGGER = logging.getLogger("ip_intel.case_app")

# We only ever store the favicon *hash*, never the icon bytes, so there's
# nothing to serve straight from the DB. This re-fetches the icon live from
# one of the domains sharing the hash, verifies it still hashes to the same
# value, and caches it on disk keyed by hash — works retroactively for every
# favicon hash already in the pool, no ingestion/schema changes needed.
FAVICON_KINDS = {"favicon_md5": "md5", "favicon_mmh3": "murmurhash3"}
FAVICON_CACHE_DIR = BASE_DIR.parent / "results" / "favicon_cache"
FAVICON_MISS_TTL_SECONDS = 3600  # don't re-hit dead domains on every card render


def _configure_logging() -> None:
    """Surface our own ``ip_intel.*`` loggers on stdout.

    Uvicorn only configures its own loggers, so by default the container logs
    show nothing but HTTP access lines (which endpoints got hit). We want the
    actual analysis progress — the same messages streamed to the user in the
    frontend — to appear in ``docker compose logs``, so we attach a stdout
    handler to the shared ``ip_intel`` parent logger and let children
    propagate to it. Level is controlled by IP_INTEL_LOG_LEVEL (default INFO).

    The chatty uvicorn.access logger (one line per UI poll of the case/job
    endpoints) is bumped to WARNING so the analysis log isn't drowned out.
    """
    level_name = os.environ.get("IP_INTEL_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger("ip_intel")
    root.setLevel(level)
    if not any(getattr(h, "_ip_intel", False) for h in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler._ip_intel = True  # type: ignore[attr-defined]
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )
        root.addHandler(handler)
    root.propagate = False

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


_configure_logging()


_CRT_SH_RETRY_INTERVAL = 300  # seconds between retry sweeps


async def _crt_sh_retry_loop() -> None:
    while True:
        await asyncio.sleep(_CRT_SH_RETRY_INTERVAL)
        try:
            updated = await asyncio.to_thread(runtime.retry_crt_sh_pending)
            if updated:
                LOGGER.info("crt.sh retry: updated %d run(s)", updated)
        except Exception as exc:
            LOGGER.warning("crt.sh retry sweep failed: %s", exc)


_CLUSTER_REBUILD_INTERVAL = 20  # seconds between graph-maintenance checks


async def _cluster_rebuild_loop() -> None:
    """Keep the whole derived graph current without the user waiting on it.

    One tick, three tiers, all of them decided in intel_db.run_graph_maintenance
    (which owns the state they key off): the incremental rescore of whatever a
    recent write invalidated, the rate-limited whole-pool cluster/path rebuild,
    and the periodic full reconcile that used to be the manual "Recompute
    graph" button. This loop stays the single scheduler for all of it — there
    is deliberately no second timer thread — so the tier logic can be exercised
    without standing up the app.

    A tick that finds nothing due returns immediately, so an idle deployment
    costs one cheap indexed SELECT every 20 seconds.
    """
    while True:
        await asyncio.sleep(_CLUSTER_REBUILD_INTERVAL)
        try:
            counts = await asyncio.to_thread(intel_db.run_graph_maintenance)
            if counts.get("tier") != "idle":
                LOGGER.info("Graph maintenance: %s", counts)
        except Exception as exc:
            LOGGER.warning("Graph maintenance sweep failed: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # Auto-recovery is OFF by default: a restart must NOT resume or re-run any
    # in-flight case (the OpenCTI sweep in particular re-scans a whole batch
    # from the start on resume). Instead, mark any job left 'queued'/'running'
    # as failed so it stops cleanly and never picks up where it left off. Set
    # RECOVER_JOBS_ON_STARTUP=1 to restore the old resume-on-boot behavior.
    if os.getenv("RECOVER_JOBS_ON_STARTUP") == "1":
        runtime.recover()
    else:
        interrupted = mark_interrupted_jobs()
        if interrupted:
            LOGGER.info("Startup: marked %d interrupted job(s) failed (auto-recovery disabled)", interrupted)
    # Invalidate through intel_db's post-commit hook rather than from the
    # rebuild loop: the hook also fires for recomputes driven from the CLI
    # scripts, which never run this process's loop. `invalidate` is a single
    # INCR of the cache generation, so it is safe to call from the DB thread.
    intel_db.register_graph_invalidation_hook(lambda scope, domains: cache.invalidate())
    retry_task = asyncio.create_task(_crt_sh_retry_loop())
    cluster_task = asyncio.create_task(_cluster_rebuild_loop())
    # Starts the background re-warm worker and queues the initial warm through
    # the same path, so boot and post-recompute warming behave identically.
    # Warming stays off the event loop either way: the pool query it fills is
    # multi-second on a large pool, and blocking boot on it would fail the
    # container healthcheck.
    cache.start_rewarm_worker()
    yield
    retry_task.cancel()
    cluster_task.cancel()
    cache.stop_rewarm_worker()


app = FastAPI(title="IP Intel", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


authenticate_request = api_auth.authenticate_request


def _auth_client_ip(request: Request) -> str | None:
    """Resolve a client address only through explicitly trusted proxy hops."""
    peer = request.client.host if request.client else None
    if not peer:
        return None
    configured = os.getenv("AUTH_TRUSTED_PROXY_CIDRS", "")
    try:
        trusted = [ip_network(value.strip(), strict=False) for value in configured.split(",") if value.strip()]
        peer_address = ip_address(peer)
    except ValueError:
        return peer
    if not any(peer_address in network for network in trusted):
        return peer
    chain = [part.strip() for part in request.headers.get("x-forwarded-for", "").split(",") if part.strip()]
    for part in reversed(chain):
        try:
            address = ip_address(part)
        except ValueError:
            return peer
        if not any(address in network for network in trusted):
            return str(address)
    return peer


@app.middleware("http")
async def require_api_login(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path != "/api/health" and not path.startswith("/api/auth/") and request.method != "OPTIONS":
        try:
            request.state.identity = await authenticate_request(request)
        except HTTPException as exc:
            return JSONResponse(
                status_code=exc.status_code,
                content={"detail": exc.detail},
                headers={"WWW-Authenticate": "Bearer"} if exc.status_code == 401 else None,
            )
        if path in {"/api/graph/recompute", "/api/graph/email"} and request.state.identity.get("role") != "admin":
            return JSONResponse(status_code=403, content={"detail": "Admin access is required."})
    return await call_next(request)


@app.api_route("/api/auth/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def auth_proxy(path: str, request: Request) -> Response:
    """Serve Better Auth on the same origin as the built frontend."""
    upstream = os.getenv("AUTH_PROXY_URL")
    if not upstream:
        raise HTTPException(status_code=503, detail="Authentication is not configured.")
    url = f"{upstream.rstrip('/')}/api/auth/{path}"
    if request.url.query:
        url += f"?{request.url.query}"
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {
            "host", "content-length", "connection", "transfer-encoding", "forwarded",
            "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip",
        }
    }
    client_ip = _auth_client_ip(request)
    if client_ip:
        headers["X-Forwarded-For"] = client_ip
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            result = await client.request(request.method, url, headers=headers, content=await request.body())
    except httpx.HTTPError as exc:
        LOGGER.warning("Authentication proxy unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="Authentication service is unavailable.") from exc
    outgoing = Response(content=result.content, status_code=result.status_code)
    for key, value in result.headers.items():
        if key.lower() not in {"content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie", "date"}:
            outgoing.headers[key] = value
    for cookie in result.headers.get_list("set-cookie"):
        outgoing.raw_headers.append((b"set-cookie", cookie.encode("latin-1")))
    return outgoing


def _etag_json_response(request: Request, content: Any) -> Response:
    """
    Serialize `content` to JSON, attach a strong ETag (hash of the body), and
    answer with 304 Not Modified when the client already holds this version.
    """
    body = json.dumps(jsonable_encoder(content), separators=(",", ":")).encode("utf-8")
    etag = f'"{hashlib.sha256(body).hexdigest()}"'
    if_none_match = request.headers.get("if-none-match")
    if if_none_match:
        client_tags = {tag.strip() for tag in if_none_match.split(",")}
        if etag in client_tags or f"W/{etag}" in client_tags or "*" in client_tags:
            return Response(status_code=304, headers={"ETag": etag})
    return Response(content=body, media_type="application/json", headers={"ETag": etag})


@app.get("/api/health")
def api_health() -> dict[str, Any]:
    return {"status": "ok", "database": healthcheck()}


@app.get("/api/meta/evidence")
def api_evidence_meta() -> dict[str, Any]:
    return {"evidence": evidence_catalog()}


def _ingest_response(identifiers: dict[str, str], *, label: str | None, count: int) -> JSONResponse:
    """Shared ingest acknowledgement: a job id to poll for progress. The scanned
    targets flow straight into the global pool — there is no case to open."""
    job_row = get_job(identifiers["job_id"])
    return JSONResponse(
        status_code=202,
        content=jsonable_encoder(
            {
                "job": build_job_response(job_row) if job_row else {"id": identifiers["job_id"]},
                "job_id": identifiers["job_id"],
                "label": label,
                "accepted": count,
                "status": "queued",
            }
        ),
    )


def _identity_display(identity: dict[str, Any]) -> str | None:
    """Use a signed human-readable claim when the issuer provided one."""
    for claim in ("name", "preferred_username", "email"):
        value = identity.get(claim)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


@app.post("/api/ingest")
async def api_ingest(request: Request) -> JSONResponse:
    """Add URLs, domains, IPs, or a CSV to the global pool. URL paths are
    reduced to their host before analysis. Results join the shared correlation
    graph. An optional `label` tags each submitted channel. Poll the
    returned job for progress; connections surface via the /api/graph/* endpoints.
    """
    content_type = (request.headers.get("content-type") or "").lower()
    target: str | None = None
    targets: list[str] | None = None
    csv_content: bytes | None = None
    label: str | None = None

    if "application/json" in content_type:
        payload = await request.json()
        payload = payload if isinstance(payload, dict) else {}
        target = str(payload.get("target") or "").strip() or None
        raw_targets = payload.get("targets")
        if isinstance(raw_targets, list):
            targets = [str(value).strip() for value in raw_targets if str(value).strip()]
        label = str(payload.get("label") or "").strip() or None
    elif "multipart/form-data" in content_type:
        form = await request.form()
        target = str(form.get("target") or "").strip() or None
        label = str(form.get("label") or "").strip() or None
        upload = form.get("file")
        if upload is not None and hasattr(upload, "read"):
            csv_content = await upload.read()
    else:
        raise HTTPException(status_code=415, detail="Use JSON or multipart form data.")

    inputs, input_mode = parse_submission(target=target, csv_content=csv_content, targets=targets)
    if not inputs:
        raise HTTPException(status_code=400, detail="Submit a URL, domain, IP, or CSV with at least one valid target.")

    identity = request.state.identity
    identifiers = runtime.submit_case(
        inputs,
        input_mode=input_mode,
        label=label,
        created_by=identity["sub"],
        created_by_display=_identity_display(identity),
    )
    if label:
        cache.invalidate()
    return _ingest_response(identifiers, label=label, count=len(inputs))


# One OpenCTI sweep at a time: a second click while batches are still running
# would re-submit every channel the first sweep hasn't finished scanning yet.
_opencti_sweep_lock = threading.Lock()
OPENCTI_SWEEP_BATCH_SIZE = 250


def _run_opencti_sweep_batches(submit, batches, normalized_labels, first_job_id: str) -> None:
    """Background half of POST /api/ingest/opencti: batches 2..N, then a graph rebuild."""
    from integrations import opencti_sweep

    try:
        result = opencti_sweep.run_batches(
            submit,
            batches,
            normalized_labels,
            poll_interval=5.0,
            first_job_id=first_job_id,
            log=lambda message: LOGGER.info("OpenCTI sweep: %s", message.strip()),
        )
        LOGGER.info(
            "OpenCTI sweep finished: %d/%d batches completed, %d partial, %d failed; labels on %d domain(s).",
            result.completed, result.batches, result.partial, result.failed, result.labels_attached,
        )
        intel_db.rebuild_clusters()
        cache.invalidate()
    except Exception:  # noqa: BLE001
        LOGGER.exception("OpenCTI sweep failed")
    finally:
        _opencti_sweep_lock.release()


@app.post("/api/ingest/opencti")
async def api_ingest_opencti(request: Request) -> JSONResponse:
    """Import every OpenCTI website channel into the pool — the same sweep as
    `scripts/ingest_opencti_channels.py`. Tiers are recorded and labels
    refreshed for every channel; only channels not already in the pool are
    scanned, in sequential batches. Returns the first batch's job to poll; the
    remaining batches appear in the jobs list as each one starts."""
    if request.state.identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access is required.")
    if not _opencti_sweep_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="An OpenCTI import is already running.")

    handed_off = False
    try:
        # Imported lazily so the app starts even when pycti / OpenCTI config is
        # absent; the dependency is only needed when this button is used.
        from integrations import opencti_sweep
        from integrations.opencti_ingest import fetch_all_website_channel_data

        try:
            domain_data = await asyncio.to_thread(fetch_all_website_channel_data)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"OpenCTI fetch failed: {exc}")

        plan = await asyncio.to_thread(opencti_sweep.prepare_sweep, domain_data)
        counts = {
            "channels": plan.channel_count,
            "tiers": plan.tiers_written,
            "skipped": plan.skipped,
            "labels_refreshed": plan.labels_refreshed,
            "accepted": len(plan.to_scan),
        }
        if not plan.to_scan:
            cache.invalidate()
            return JSONResponse(content={**counts, "job_id": None, "batches": 0, "status": "nothing_new"})

        identity = request.state.identity

        def submit(batch_inputs):
            return runtime.submit_case(
                batch_inputs,
                input_mode=opencti_sweep.INPUT_MODE,
                created_by=identity["sub"],
                created_by_display=_identity_display(identity),
            )

        batches = opencti_sweep.split_batches(plan.to_scan, OPENCTI_SWEEP_BATCH_SIZE)
        identifiers = submit(batches[0])
        threading.Thread(
            target=_run_opencti_sweep_batches,
            args=(submit, batches, plan.normalized_labels, identifiers["job_id"]),
            name="opencti-sweep",
            daemon=True,
        ).start()
        handed_off = True
    finally:
        if not handed_off:
            _opencti_sweep_lock.release()

    job_row = get_job(identifiers["job_id"])
    return JSONResponse(
        status_code=202,
        content=jsonable_encoder(
            {
                **counts,
                "job": build_job_response(job_row) if job_row else {"id": identifiers["job_id"]},
                "job_id": identifiers["job_id"],
                "batches": len(batches),
                "status": "queued",
            }
        ),
    )


# ── The pool ─────────────────────────────────────────────────────────────────

@app.get("/api/pool")
def api_pool(
    request: Request,
    search: str | None = None,
    limit: int = 1000,
    offset: int = 0,
    provenance: str | None = None,
    sort: str = "recent",
    min_connections: int | None = None,
    max_connections: int | None = None,
    ingested_after: str | None = None,
    ingested_before: str | None = None,
    discovered_after: str | None = None,
    discovered_before: str | None = None,
) -> Response:
    """Every channel (registrable domain) in the pool, with host count, recency,
    pairwise connection count, and cluster membership.

    ``total`` is the filtered total before pagination; ``domains`` is the
    current page.
    """
    page = cache.pool_page(
        search=search,
        limit=limit,
        offset=offset,
        provenance=provenance,
        sort=sort,
        min_connections=min_connections,
        max_connections=max_connections,
        ingested_after=ingested_after,
        ingested_before=ingested_before,
        discovered_after=discovered_after,
        discovered_before=discovered_before,
        labels=request.query_params.getlist("label"),
    )
    return _etag_json_response(request, page)


@app.get("/api/labels")
def api_labels() -> dict[str, Any]:
    """Known ingest labels and the number of channels carrying each one."""
    return {"labels": intel_db.list_channel_labels()}


@app.post("/api/labels/archive")
async def api_archive_label(request: Request) -> dict[str, Any]:
    if request.state.identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access is required.")
    payload = await request.json()
    label = str(payload.get("label") or "").strip() if isinstance(payload, dict) else ""
    if not label:
        raise HTTPException(status_code=400, detail="Choose a label to archive.")
    count = archive_channels_with_label(label, archived_by=request.state.identity["sub"])
    cache.invalidate()
    return {"label": label, "archived": count}


@app.get("/api/domain/{value:path}")
def api_domain(value: str, request: Request) -> Response:
    """Everything gathered on one channel — hosts, extracted selectors, resolved
    IPs, and the raw intel (DNS/WHOIS/TLS/subdomains/trackers) — whether or not
    it has any connections."""
    profile = cache.domain_profile(value)
    if profile is None:
        raise HTTPException(status_code=404, detail="Nothing in the pool for this channel yet.")
    return _etag_json_response(request, profile)


# ── Global correlation graph (case-free) ─────────────────────────────────────

_EMPTY_VERDICT_SUMMARY = {"counts": {"same_owner": 0, "different_owner": 0, "unsure": 0}, "verdicts": []}


def _csv_safe(value: Any) -> Any:
    """Keep analyst notes and display names inert in spreadsheet viewers."""
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _pair_verdict_summary(a: str, b: str) -> dict[str, Any]:
    key = intel_db.canonical_verdict_pair(a, b)
    return intel_db.verdict_summaries_for_pairs([key]).get(key, _EMPTY_VERDICT_SUMMARY)


@app.put("/api/verdicts")
async def api_record_verdict(request: Request) -> dict[str, Any]:
    """Record a user's new verdict while preserving their earlier judgements."""
    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Provide a JSON verdict.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Provide a JSON verdict.")
    try:
        a, b = intel_db.canonical_verdict_pair(payload.get("a"), payload.get("b"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    verdict = payload.get("verdict")
    if not isinstance(verdict, str) or verdict not in intel_db.VERDICTS:
        raise HTTPException(status_code=400, detail="Choose same owner, different owner, or unsure.")
    note = payload.get("note")
    if note is not None and not isinstance(note, str):
        raise HTTPException(status_code=400, detail="The note must be text.")
    note = note.strip() or None if note is not None else None
    if note and len(note) > 10000:
        raise HTTPException(status_code=400, detail="The note is too long.")
    identity = request.state.identity
    user_display = identity.get("name") or identity.get("preferred_username") or identity.get("email")
    # A fresh server-side score is the historical snapshot. Caller-supplied
    # score and evidence fields are deliberately ignored.
    link = await asyncio.to_thread(check.link_evidence, a, b)
    record = await asyncio.to_thread(
        intel_db.record_pair_verdict, a, b, verdict, note, identity["sub"], user_display, link,
    )
    summary = await asyncio.to_thread(_pair_verdict_summary, a, b)
    return {"record": record, "verdict_summary": summary}


@app.get("/api/verdicts/export")
def api_export_verdicts(request: Request, format: str = "json") -> Response:
    """Admin-only complete verdict history with point-in-time score snapshots."""
    if request.state.identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access is required.")
    rows = intel_db.export_pair_verdicts()
    if format == "json":
        return JSONResponse({"verdicts": rows})
    if format != "csv":
        raise HTTPException(status_code=400, detail="Choose json or csv format.")
    output = StringIO()
    fields = ["id", "a", "b", "verdict", "note", "user_id", "user_display", "created_at", "score", "strength", "evidence_kinds"]
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_safe(value) for key, value in {
            **row, "evidence_kinds": json.dumps(row["evidence_kinds"]),
        }.items()})
    return Response(
        content=output.getvalue(), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="pair-verdicts.csv"'},
    )


@app.get("/api/verdicts")
def api_get_verdicts(a: str | None = None, b: str | None = None, domain: str | None = None) -> dict[str, Any]:
    if domain is not None and a is None and b is None:
        try:
            normalized = intel_db.normalize_verdict_domain(domain)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"domain": normalized, "pairs": intel_db.verdict_summaries_for_domain(normalized)}
    if a is None or b is None or domain is not None:
        raise HTTPException(status_code=400, detail="Provide a and b, or one domain.")
    try:
        left, right = intel_db.canonical_verdict_pair(a, b)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"a": left, "b": right, **_pair_verdict_summary(left, right)}

@app.post("/api/graph/connections")
async def api_graph_connections(request: Request) -> dict[str, Any]:
    """Connections within a selected set of channels: which of them link to each
    other (with evidence), plus each one's strongest connections to the pool.

    Body: {"domains": ["a.com", "b.com", ...], "pool_links": bool}
    """
    payload = await request.json()
    domains = [str(d).strip() for d in (payload or {}).get("domains") or [] if str(d).strip()]
    if len(domains) < 1:
        raise HTTPException(status_code=400, detail="Provide a 'domains' list.")
    pool_links = bool((payload or {}).get("pool_links"))
    result = cache.graph_connections(domains, pool_links=pool_links)
    pairs = result.get("pairs", [])
    pool = result.get("pool_links") or {}
    verdict_pairs = [(pair["a"], pair["b"]) for pair in pairs]
    for domain, links in pool.items():
        for link in links or []:
            if link.get("target"):
                verdict_pairs.append((domain, link["target"]))
    summaries = intel_db.verdict_summaries_for_pairs(verdict_pairs)

    def summary_for(a: str, b: str) -> dict[str, Any]:
        try:
            key = intel_db.canonical_verdict_pair(a, b)
        except ValueError:
            return _EMPTY_VERDICT_SUMMARY
        return summaries.get(key, _EMPTY_VERDICT_SUMMARY)

    return {
        **result,
        "pairs": [
            {**pair, "verdict_summary": summary_for(pair["a"], pair["b"])}
            for pair in pairs
        ],
        **({"pool_links": {
            domain: [{**link, "verdict_summary": summary_for(domain, link["target"])} for link in links or []]
            for domain, links in pool.items()
        }} if pool_links else {}),
    }


@app.post("/api/graph/email")
async def api_graph_email(
    image: UploadFile = File(...),
    report: UploadFile | None = File(None),
    domains: str = Form("[]"),
) -> dict[str, Any]:
    """Email an exported network-graph PNG (plus, if provided, the clickable
    HTML report) to the configured alert recipients (SMTP_HOST / ALERT_EMAIL_TO
    in .env -- see integrations.email_alerts)."""
    from integrations.email_alerts import email_enabled, send_network_graph_email

    if not email_enabled():
        raise HTTPException(
            status_code=409,
            detail="Email alerts aren't configured. Set SMTP_HOST and ALERT_EMAIL_TO in .env.",
        )

    try:
        domain_list = json.loads(domains)
        if not isinstance(domain_list, list):
            domain_list = []
    except (TypeError, ValueError):
        domain_list = []

    png_bytes = await image.read()
    if not png_bytes:
        raise HTTPException(status_code=400, detail="No image data received.")
    html_bytes = await report.read() if report is not None else None

    sent = send_network_graph_email(
        png_bytes, domains=[str(d) for d in domain_list], html_bytes=html_bytes or None
    )
    return {"status": "sent" if sent else "failed"}


@app.get("/api/graph/selector-kinds")
def api_graph_selector_kinds(request: Request, min_domains: int = 2) -> Response:
    """Edge types available for browsing (selector kind / shared_ip) + group counts."""
    return _etag_json_response(request, {"kinds": cache.selector_kinds(min_domains=min_domains)})


@app.get("/api/graph/by-selector")
def api_graph_by_selector(
    request: Request, kind: str | None = None, min_domains: int = 2, limit: int = 200
) -> Response:
    """Browse by edge type: groups of domains that share a selector of `kind`
    (or any kind), e.g. all domain sets sharing a TLS cert / SSH key / IP."""
    groups = cache.by_selector(kind=kind, min_domains=min_domains, limit=limit)
    return _etag_json_response(request, {"kind": kind, "total": len(groups), "groups": groups})


def _favicon_cache_key(kind: str, value: str) -> str:
    safe_value = re.sub(r"[^a-zA-Z0-9_-]", "_", value)[:128]
    return f"{kind}__{safe_value}"


@app.get("/api/favicon/{kind}/{value:path}")
async def api_favicon_image(kind: str, value: str) -> Response:
    """Best-effort favicon image for a shared favicon_md5/favicon_mmh3 group.
    404s (frontend falls back to showing the hash) if no member domain
    currently serves a matching icon."""
    hash_field = FAVICON_KINDS.get(kind)
    if hash_field is None:
        raise HTTPException(status_code=400, detail="Unsupported favicon kind.")

    FAVICON_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = _favicon_cache_key(kind, value)
    matches = list(FAVICON_CACHE_DIR.glob(f"{key}.*"))
    hit = next((p for p in matches if p.suffix != ".miss"), None)
    if hit is not None:
        return FileResponse(
            hit,
            media_type=mimetypes.guess_type(hit.name)[0] or "image/x-icon",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    miss = next((p for p in matches if p.suffix == ".miss"), None)
    if miss is not None and time.time() - miss.stat().st_mtime < FAVICON_MISS_TTL_SECONDS:
        raise HTTPException(status_code=404, detail="No live favicon found for this hash.")

    for domain in intel_db.domains_for_selector_value(kind, value):
        try:
            result = await signal_web.async_fetch_favicons(domain, include_content=True)
        except Exception:
            continue
        for icon in result.get("icons", []):
            content = icon.get("content")
            if not content or str(icon.get(hash_field)) != value:
                continue
            content_type = (icon.get("content_type") or "image/x-icon").split(";")[0].strip()
            ext = mimetypes.guess_extension(content_type) or ".ico"
            cache_path = FAVICON_CACHE_DIR / f"{key}{ext}"
            cache_path.write_bytes(content)
            return Response(
                content=content, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"}
            )

    (FAVICON_CACHE_DIR / f"{key}.miss").write_bytes(b"")
    raise HTTPException(status_code=404, detail="No live favicon found for this hash.")


@app.get("/api/graph/links/{value:path}")
def api_graph_links(value: str, request: Request, limit: int = 50) -> Response:
    """Ranked cross-corpus connections for an entity / registrable domain, each
    with its shared-node evidence breakdown."""
    page = cache.graph_links(value, limit=limit)
    # Older cache entries were a bare list. Treating those as a completed page
    # avoids a transient server error during a rolling upgrade, while fresh
    # entries always carry the honest total and truncation state.
    if isinstance(page, list):
        links = page
        page = {"links": links, "total": len(links), "limit": len(links), "has_more": False}
    else:
        links = page.get("links", [])
    pairs = []
    for link in links:
        try:
            pairs.append(intel_db.canonical_verdict_pair(value, link["target"]))
        except ValueError:
            pass
    summaries = intel_db.verdict_summaries_for_pairs(pairs)
    annotated = []
    for link in links:
        try:
            key = intel_db.canonical_verdict_pair(value, link["target"])
        except ValueError:
            key = None
        annotated.append({**link, "verdict_summary": summaries.get(key, _EMPTY_VERDICT_SUMMARY)})
    return _etag_json_response(request, {
        "target": value,
        "total": page.get("total", len(links)),
        "limit": page.get("limit", len(links)),
        "has_more": bool(page.get("has_more")),
        "links": annotated,
    })


@app.get("/api/graph/link")
def api_graph_link(a: str, b: str, request: Request) -> Response:
    """Connecting evidence (shared selectors / IPs) between two domains."""
    if not a or not b:
        raise HTTPException(status_code=400, detail="Provide both 'a' and 'b' query parameters.")
    return _etag_json_response(request, {"link": check.link_evidence(a, b)})


@app.get("/api/graph/path")
def api_graph_path(a: str, b: str, request: Request) -> Response:
    """Precomputed shortest evidence chain connecting two channels (see
    db.intel_db.path_between / graph_paths) — explains a same-cluster or
    otherwise-reachable relationship hop by hop. Always an indexed read,
    never scored live."""
    if not a or not b:
        raise HTTPException(status_code=400, detail="Provide both 'a' and 'b' query parameters.")
    path = intel_db.path_between(a, b)
    if path is None:
        status = intel_db.path_status_for(a)
        detail = "No precomputed path within the configured hop limit."
        if status and status.get("partial"):
            detail += " The source traversal reached a search limit, so this is not proof that no longer path exists."
        if status and status.get("stale"):
            detail += " The path index is waiting for its next rebuild, so newer connections may not be represented yet."
        raise HTTPException(status_code=404, detail=detail)
    return _etag_json_response(request, {"path": path})


@app.get("/api/graph/related/{value:path}")
def api_graph_related(value: str, request: Request, max_hops: int | None = None, min_hops: int | None = None, limit: int = 50) -> Response:
    """A channel's precomputed multi-hop neighborhood (direct links plus
    everything reachable through an intermediary), strongest/shortest first."""
    kwargs = {"max_hops": max_hops, "limit": limit}
    if min_hops is not None:
        kwargs["min_hops"] = min_hops
    page = intel_db.related_through_page(value, **kwargs)
    return _etag_json_response(request, {"target": value, **page})


@app.get("/api/search")
def api_search(q: str, request: Request, limit: int = 20) -> Response:
    """Ranked domain / selector-value matches for the global search box."""
    return _etag_json_response(request, cache.search(q, limit=limit))


@app.get("/api/graph/clusters")
def api_graph_clusters(request: Request, min_size: int = 2, limit: int = 100) -> Response:
    """Strongest clusters lake-wide."""
    clusters = cache.graph_clusters(min_size=min_size, limit=limit)
    return _etag_json_response(request, {"total": len(clusters), "clusters": clusters})


@app.get("/api/graph/cluster/{value:path}")
def api_graph_cluster(value: str) -> dict[str, Any]:
    """The cluster a registrable domain belongs to, with its members."""
    cluster = intel_db.graph_cluster_for(value)
    if cluster is None:
        raise HTTPException(status_code=404, detail="No cluster for this target.")
    return {"target": value, **cluster}


@app.post("/api/graph/recompute")
async def api_graph_recompute() -> dict[str, Any]:
    """Global recompute: rebuild the whole correlation graph + clusters from
    stored intel (no rescanning). Run after changing extraction/weight logic."""
    counts = await asyncio.to_thread(intel_db.rebuild_all_correlation)
    return {"status": "recomputed", **counts}


@app.get("/api/jobs")
def api_list_jobs(status: str, limit: int | None = None) -> dict[str, Any]:
    """List active work or recently finished scans across the shared pool."""
    if status not in {"active", "recent"}:
        raise HTTPException(status_code=422, detail="status must be 'active' or 'recent'.")
    default_limit = 5_000 if status == "active" else 50
    max_limit = 10_000 if status == "active" else 200
    requested_limit = default_limit if limit is None else limit
    if not 1 <= requested_limit <= max_limit:
        raise HTTPException(status_code=422, detail=f"limit must be between 1 and {max_limit} for {status} jobs.")
    return {
        "jobs": [
            build_job_response(job)
            for job in list_jobs(status=status, limit=requested_limit)
        ]
    }


@app.get("/api/jobs/{job_id}")
def api_get_job(job_id: str) -> dict[str, Any]:
    job_row = get_job(job_id)
    if job_row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return {"job": build_job_response(job_row)}


@app.exception_handler(Exception)
async def api_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    LOGGER.exception("Unhandled request error on %s", request.url.path)
    if request.url.path.startswith("/api/"):
        return JSONResponse(
            status_code=500,
            content={
                "detail": str(exc) or "Internal Server Error",
                "path": request.url.path,
            },
        )
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str) -> FileResponse:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Route not found.")
    candidate = FRONTEND_DIST / full_path
    if candidate.exists() and candidate.is_file():
        return FileResponse(candidate)
    index_file = FRONTEND_DIST / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=404, detail="Frontend build not found.")
    return FileResponse(index_file)
