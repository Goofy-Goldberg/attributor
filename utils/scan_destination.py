"""Connection-time destination checks for untrusted scan targets.

The validated address is the address used for the connection.  Re-resolving a
hostname after validation would permit a DNS answer to change between the
check and the socket connection.  This module is deliberately only used for
scan targets; provider APIs and the application's own services have separate
connection paths.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from contextvars import ContextVar
from urllib.parse import urlsplit

import httpx

from utils.outbound import outbound_proxy_url


# httpcore 1.0.9 (pinned by uv.lock) ignores the sni_hostname extension in its
# HTTP CONNECT tunnel. The per-attempt context is captured by a stream wrapper
# when the proxy socket opens, so concurrent requests never share a mutable
# target hostname. Direct and SOCKS transports use httpcore's SNI extension.
_PROXY_PIN: ContextVar[tuple[str, str] | None] = ContextVar("scan_proxy_pin", default=None)


class _ProxyTLSStream:
    def __init__(self, stream: object, host: str, address: str, *, proxy_tls_pending: bool) -> None:
        self._stream = stream
        self._host = host
        self._address = address
        self._proxy_tls_pending = proxy_tls_pending

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return self._stream.read(max_bytes, timeout=timeout)

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        return self._stream.write(buffer, timeout=timeout)

    def close(self) -> None:
        return self._stream.close()

    def get_extra_info(self, info: str) -> object:
        return self._stream.get_extra_info(info)

    def start_tls(self, ssl_context: object, server_hostname: str | None = None, timeout: float | None = None) -> "_ProxyTLSStream":
        outer_proxy_tls = self._proxy_tls_pending
        hostname = self._host if not outer_proxy_tls and server_hostname == self._address else server_hostname
        stream = self._stream.start_tls(ssl_context, server_hostname=hostname, timeout=timeout)
        return _ProxyTLSStream(stream, self._host, self._address, proxy_tls_pending=False)


class _AsyncProxyTLSStream:
    def __init__(self, stream: object, host: str, address: str, *, proxy_tls_pending: bool) -> None:
        self._stream = stream
        self._host = host
        self._address = address
        self._proxy_tls_pending = proxy_tls_pending

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return await self._stream.read(max_bytes, timeout=timeout)

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        return await self._stream.write(buffer, timeout=timeout)

    async def aclose(self) -> None:
        return await self._stream.aclose()

    def get_extra_info(self, info: str) -> object:
        return self._stream.get_extra_info(info)

    async def start_tls(self, ssl_context: object, server_hostname: str | None = None, timeout: float | None = None) -> "_AsyncProxyTLSStream":
        outer_proxy_tls = self._proxy_tls_pending
        hostname = self._host if not outer_proxy_tls and server_hostname == self._address else server_hostname
        stream = await self._stream.start_tls(ssl_context, server_hostname=hostname, timeout=timeout)
        return _AsyncProxyTLSStream(stream, self._host, self._address, proxy_tls_pending=False)


class _ProxyBackend:
    def __init__(self, backend: object, *, proxy_tls: bool) -> None:
        self._backend = backend
        self._proxy_tls = proxy_tls

    def connect_tcp(self, **kwargs: object) -> _ProxyTLSStream:
        stream = self._backend.connect_tcp(**kwargs)
        pin = _PROXY_PIN.get()
        return _ProxyTLSStream(stream, *pin, proxy_tls_pending=self._proxy_tls) if pin else stream

    def connect_unix_socket(self, **kwargs: object) -> _ProxyTLSStream:
        stream = self._backend.connect_unix_socket(**kwargs)
        pin = _PROXY_PIN.get()
        return _ProxyTLSStream(stream, *pin, proxy_tls_pending=self._proxy_tls) if pin else stream

    def sleep(self, seconds: float) -> None:
        return self._backend.sleep(seconds)


class _AsyncProxyBackend:
    def __init__(self, backend: object, *, proxy_tls: bool) -> None:
        self._backend = backend
        self._proxy_tls = proxy_tls

    async def connect_tcp(self, **kwargs: object) -> _AsyncProxyTLSStream:
        stream = await self._backend.connect_tcp(**kwargs)
        pin = _PROXY_PIN.get()
        return _AsyncProxyTLSStream(stream, *pin, proxy_tls_pending=self._proxy_tls) if pin else stream

    async def connect_unix_socket(self, **kwargs: object) -> _AsyncProxyTLSStream:
        stream = await self._backend.connect_unix_socket(**kwargs)
        pin = _PROXY_PIN.get()
        return _AsyncProxyTLSStream(stream, *pin, proxy_tls_pending=self._proxy_tls) if pin else stream

    async def sleep(self, seconds: float) -> None:
        return await self._backend.sleep(seconds)


def _http_proxy_scheme(proxy: str | None) -> str | None:
    scheme = urlsplit(proxy).scheme.lower() if proxy else ""
    return scheme if scheme in {"http", "https"} else None


def _install_proxy_backend(transport: object, proxy_scheme: str | None, *, asynchronous: bool) -> None:
    if proxy_scheme is None:
        return
    # The private pool hook is isolated here. Both HTTPX 0.28.1 and httpcore
    # 1.0.9 are frozen in uv.lock and covered by the proxy handshake tests.
    pool = transport._pool
    backend = pool._network_backend
    pool._network_backend = (
        _AsyncProxyBackend(backend, proxy_tls=proxy_scheme == "https") if asynchronous
        else _ProxyBackend(backend, proxy_tls=proxy_scheme == "https")
    )


class UnsafeScanDestination(ValueError):
    """A scan destination is not a public Internet address."""


def public_address(value: str) -> str:
    """Return a canonical public IP address, or reject it."""
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise UnsafeScanDestination(f"Invalid scan address: {value}") from exc
    if (
        not address.is_global
        or address.is_multicast
        or address.is_reserved
        or getattr(address, "is_site_local", False)
    ):
        raise UnsafeScanDestination(f"Non-public scan address: {address}")
    return str(address)


def _validated_addresses(answers: list[tuple], host: str) -> tuple[str, ...]:
    addresses = tuple(dict.fromkeys(answer[4][0] for answer in answers))
    if not addresses:
        raise UnsafeScanDestination(f"No scan addresses for {host}")
    for address in addresses:
        public_address(address)
    return addresses


def resolve_public_addresses(host: str, port: int) -> tuple[str, ...]:
    """Resolve once and reject a hostname if any answer is non-public."""
    try:
        return (public_address(host),)
    except UnsafeScanDestination:
        # Literal IPs must fail here, not fall through to a name lookup.
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise

    return _validated_addresses(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM), host)


async def async_resolve_public_addresses(host: str, port: int) -> tuple[str, ...]:
    """Resolve without blocking the event loop, then pin the validated IPs."""
    try:
        return (public_address(host),)
    except UnsafeScanDestination:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise
    answers = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return _validated_addresses(answers, host)


def resolve_public_address(host: str, port: int) -> str:
    """First validated address, for callers that need one address only."""
    return resolve_public_addresses(host, port)[0]


def scan_socket(host: str, port: int, *, timeout: float) -> socket.socket:
    """Open a raw probe to an address selected by the public-address check."""
    last_error: OSError | None = None
    for address in resolve_public_addresses(host, port):
        try:
            return socket.create_connection((address, port), timeout=timeout)
        except OSError as exc:
            last_error = exc
    assert last_error is not None
    raise last_error


def _request_host_and_port(request: httpx.Request) -> tuple[str, int]:
    if request.url.scheme not in {"http", "https"}:
        raise UnsafeScanDestination(f"Unsupported scan URL scheme: {request.url.scheme}")
    host = request.url.host
    if not host:
        raise UnsafeScanDestination("Scan URL has no host")
    return host, request.url.port or (443 if request.url.scheme == "https" else 80)


def _pinned_request(request: httpx.Request, address: str | None = None, *, http_proxy: bool = False) -> httpx.Request:
    host, port = _request_host_and_port(request)
    address = public_address(address) if address else resolve_public_address(host, port)
    extensions = dict(request.extensions)
    if http_proxy:
        # httpcore forwards these extensions to CONNECT. An HTTPS proxy must
        # verify *its own* hostname on the outer TLS handshake.
        extensions.pop("sni_hostname", None)
    else:
        extensions["sni_hostname"] = host
    return httpx.Request(
        request.method,
        request.url.copy_with(host=address),
        headers=request.headers,
        stream=request.stream,
        extensions=extensions,
    )


class SafeScanTransport(httpx.BaseTransport):
    """Validate each HTTP request, including redirects, before connecting."""

    def __init__(self) -> None:
        # A proxy receives an IP destination, so neither HTTP CONNECT nor
        # SOCKS may resolve the original hostname independently.  The proxy
        # itself is trusted infrastructure and may have a private address.
        proxy = outbound_proxy_url()
        self._proxy_scheme = _http_proxy_scheme(proxy)
        self._transport = httpx.HTTPTransport(
            proxy=proxy,
            trust_env=False,
            limits=httpx.Limits(max_keepalive_connections=0),
        )
        _install_proxy_backend(self._transport, self._proxy_scheme, asynchronous=False)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        host, port = _request_host_and_port(request)
        addresses = resolve_public_addresses(host, port)
        for index, address in enumerate(addresses):
            try:
                token = _PROXY_PIN.set((host, address)) if self._proxy_scheme else None
                try:
                    return self._transport.handle_request(_pinned_request(request, address, http_proxy=bool(self._proxy_scheme)))
                finally:
                    if token is not None:
                        _PROXY_PIN.reset(token)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError):
                if index == len(addresses) - 1:
                    raise
        raise AssertionError("No validated scan address")

    def close(self) -> None:
        self._transport.close()


class AsyncSafeScanTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        proxy = outbound_proxy_url()
        self._proxy_scheme = _http_proxy_scheme(proxy)
        self._transport = httpx.AsyncHTTPTransport(
            proxy=proxy,
            trust_env=False,
            limits=httpx.Limits(max_keepalive_connections=0),
        )
        _install_proxy_backend(self._transport, self._proxy_scheme, asynchronous=True)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host, port = _request_host_and_port(request)
        addresses = await async_resolve_public_addresses(host, port)
        for index, address in enumerate(addresses):
            try:
                token = _PROXY_PIN.set((host, address)) if self._proxy_scheme else None
                try:
                    return await self._transport.handle_async_request(_pinned_request(request, address, http_proxy=bool(self._proxy_scheme)))
                finally:
                    if token is not None:
                        _PROXY_PIN.reset(token)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError):
                if index == len(addresses) - 1:
                    raise
        raise AssertionError("No validated scan address")

    async def aclose(self) -> None:
        await self._transport.aclose()


def scan_client(**kwargs: object) -> httpx.Client:
    return httpx.Client(transport=SafeScanTransport(), trust_env=False, **kwargs)


def async_scan_client(**kwargs: object) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=AsyncSafeScanTransport(), trust_env=False, **kwargs)
