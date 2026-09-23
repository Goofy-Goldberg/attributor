"""Verify Better Auth JWTs at the FastAPI boundary.

The browser obtains a short-lived JWT using its Better Auth session cookie.
FastAPI verifies the signature with Better Auth's public JWKS; it never trusts
browser-provided role headers or a frontend-only route guard.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import time
from typing import Any
from urllib.parse import urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException, Request


_JWKS_CACHE: dict[str, Any] = {"keys": [], "expires_at": 0.0, "last_forced_at": 0.0}


def _issuer_origin(value: str) -> str:
    """Match JavaScript URL.origin, which Better Auth uses for JWT claims."""
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return ""
        hostname = parsed.hostname
        host = f"[{hostname}]" if ":" in hostname else hostname.encode("idna").decode("ascii")
        port = parsed.port
        default_port = 443 if parsed.scheme == "https" else 80
        return f"{parsed.scheme}://{host}{f':{port}' if port and port != default_port else ''}"
    except (UnicodeError, ValueError):
        return ""


def _decode_segment(segment: str) -> bytes:
    try:
        return base64.b64decode(segment + "=" * (-len(segment) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token.") from exc


def _token_parts(token: str) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes]:
    parts = token.split(".")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    try:
        header = json.loads(_decode_segment(parts[0]))
        payload = json.loads(_decode_segment(parts[1]))
        signature = _decode_segment(parts[2])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token.") from exc
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    try:
        signed = f"{parts[0]}.{parts[1]}".encode("ascii")
    except UnicodeEncodeError as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token.") from exc
    return header, payload, signature, signed


async def _get_jwks(*, refresh: bool = False) -> list[dict[str, Any]]:
    if not refresh and time.monotonic() < _JWKS_CACHE["expires_at"]:
        return _JWKS_CACHE["keys"]
    url = os.getenv("AUTH_JWKS_URL")
    if not url:
        raise HTTPException(status_code=503, detail="Authentication is not configured.")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(url)
            response.raise_for_status()
            body = response.json()
        keys = body.get("keys") if isinstance(body, dict) else None
        if not isinstance(keys, list):
            raise ValueError("Invalid JWKS response")
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Authentication service is unavailable.") from exc
    _JWKS_CACHE.update(keys=keys, expires_at=time.monotonic() + 300)
    return keys


async def authenticate_request(request: Request) -> dict[str, Any]:
    issuer = _issuer_origin(os.getenv("AUTH_ISSUER", ""))
    if not issuer:
        raise HTTPException(status_code=503, detail="Authentication is not configured.")
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    if len(token) > 8192:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")

    header, payload, signature, signed = _token_parts(token)
    kid = header.get("kid")
    if header.get("alg") != "EdDSA" or not isinstance(kid, str):
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    keys = await _get_jwks()
    key = next((item for item in keys if isinstance(item, dict) and item.get("kid") == kid), None)
    if key is None and time.monotonic() - _JWKS_CACHE["last_forced_at"] > 10:
        _JWKS_CACHE["last_forced_at"] = time.monotonic()
        keys = await _get_jwks(refresh=True)
        key = next((item for item in keys if isinstance(item, dict) and item.get("kid") == kid), None)
    if not key or key.get("kty") != "OKP" or key.get("crv") != "Ed25519":
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    try:
        public_key = Ed25519PublicKey.from_public_bytes(_decode_segment(key["x"]))
        public_key.verify(signature, signed)
    except (InvalidSignature, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token.") from exc

    now = time.time()
    audience = payload.get("aud")
    if (
        payload.get("iss") != issuer
        or not isinstance(payload.get("sub"), str)
        or not payload["sub"]
        or not isinstance(payload.get("exp"), (int, float))
        or payload["exp"] <= now
        or (isinstance(payload.get("nbf"), (int, float)) and payload["nbf"] > now)
        or (audience != issuer and (not isinstance(audience, list) or issuer not in audience))
        or payload.get("role") not in {"user", "admin"}
    ):
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    return payload
