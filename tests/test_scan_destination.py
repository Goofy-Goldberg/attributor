"""Offline checks for every untrusted scan connection path."""

import asyncio
import socket
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from core.analysis_service import clean_target
from core.ip_intel import _validate_scan_cidrs
from sources import signal_transport
from utils.scan_destination import (
    AsyncSafeScanTransport,
    SafeScanTransport,
    UnsafeScanDestination,
    _pinned_request,
    public_address,
    resolve_public_address,
    scan_socket,
)
from utils import scan_destination


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "224.0.0.1", "::1", "fe80::1", "fc00::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1"],
)
def test_non_public_literals_are_rejected(address):
    with pytest.raises(UnsafeScanDestination):
        public_address(address)
    assert clean_target(address) == ""


def test_public_literals_are_accepted():
    assert public_address("1.1.1.1") == "1.1.1.1"
    assert clean_target("https://1.1.1.1/path") == "1.1.1.1"
    assert public_address("2606:4700:4700::1111") == "2606:4700:4700::1111"


def test_dns_answers_are_checked_and_only_validated_ip_is_connected(monkeypatch):
    seen = []

    def answers(_host, _port, **_kwargs):
        seen.append("resolve")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]

    def connect(address, **_kwargs):
        seen.append(address)
        return object()

    monkeypatch.setattr(socket, "getaddrinfo", answers)
    monkeypatch.setattr(socket, "create_connection", connect)
    scan_socket("example.org", 443, timeout=1)
    assert seen == ["resolve", ("1.1.1.1", 443)]


def test_dns_rebinding_and_mixed_answers_fail_closed(monkeypatch):
    calls = 0

    def changing(_host, _port, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

    monkeypatch.setattr(socket, "getaddrinfo", changing)
    assert resolve_public_address("example.org", 443) == "1.1.1.1"
    with pytest.raises(UnsafeScanDestination):
        resolve_public_address("example.org", 443)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443)),
    ])
    with pytest.raises(UnsafeScanDestination):
        resolve_public_address("example.org", 443)


def test_http_request_pins_ip_but_keeps_host_and_sni(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
    ])
    request = httpx.Request("GET", "https://example.org/path")
    pinned = _pinned_request(request)
    assert pinned.url.host == "1.1.1.1"
    assert pinned.headers["host"] == "example.org"
    assert pinned.extensions["sni_hostname"] == "example.org"


def test_redirect_target_is_checked_before_transport(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
    ])
    transport = SafeScanTransport()
    requested = []

    def fake_send(request):
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})

    monkeypatch.setattr(transport._transport, "handle_request", fake_send)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(UnsafeScanDestination):
            client.get("https://example.org/", follow_redirects=True)
    assert requested == ["https://1.1.1.1/"]


def test_public_redirect_is_pinned_on_each_hop(monkeypatch):
    def answers(host, _port, **_kwargs):
        address = {"first.example": "1.1.1.1", "second.example": "8.8.8.8"}[host]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

    monkeypatch.setattr(socket, "getaddrinfo", answers)
    transport = SafeScanTransport()
    requested = []

    def fake_send(request):
        requested.append((str(request.url), request.headers["host"]))
        if len(requested) == 1:
            return httpx.Response(302, headers={"location": "https://second.example/page"})
        return httpx.Response(200, text="ok")

    monkeypatch.setattr(transport._transport, "handle_request", fake_send)
    with httpx.Client(transport=transport) as client:
        response = client.get("https://first.example/", follow_redirects=True)
    assert response.url == httpx.URL("https://second.example/page")
    assert requested == [("https://1.1.1.1/", "first.example"), ("https://8.8.8.8/page", "second.example")]


def test_http_falls_back_to_second_validated_address(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
    ])
    transport = SafeScanTransport()
    requested = []

    def fake_send(request):
        requested.append(request.url.host)
        if len(requested) == 1:
            raise httpx.ConnectError("first address unreachable")
        return httpx.Response(200, text="ok")

    monkeypatch.setattr(transport._transport, "handle_request", fake_send)
    with httpx.Client(transport=transport) as client:
        assert client.get("https://example.org/").status_code == 200
    assert requested == ["1.1.1.1", "8.8.8.8"]


def test_raw_socket_falls_back_to_second_validated_address(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 22)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 22)),
    ])
    requested = []

    def connect(address, **_kwargs):
        requested.append(address)
        if len(requested) == 1:
            raise OSError("first address unreachable")
        return object()

    monkeypatch.setattr(socket, "create_connection", connect)
    scan_socket("example.org", 22, timeout=1)
    assert requested == [("1.1.1.1", 22), ("8.8.8.8", 22)]


def test_async_transport_checks_redirect_destinations(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))
    ])

    async def run():
        transport = AsyncSafeScanTransport()
        requested = []

        async def fake_send(request):
            requested.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://[::1]/admin"})

        monkeypatch.setattr(transport._transport, "handle_async_request", fake_send)
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(UnsafeScanDestination):
                await client.get("https://example.org/", follow_redirects=True)
        return requested

    assert asyncio.run(run()) == ["https://1.1.1.1/"]


def test_async_transport_falls_back_without_sync_resolution(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: pytest.fail("sync DNS lookup"))

    async def run():
        loop = asyncio.get_running_loop()

        async def answers(_host, _port, **_kwargs):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            ]

        monkeypatch.setattr(loop, "getaddrinfo", answers)
        transport = AsyncSafeScanTransport()
        requested = []

        async def fake_send(request):
            requested.append(request.url.host)
            if len(requested) == 1:
                raise httpx.ConnectError("first address unreachable")
            return httpx.Response(200, text="ok")

        monkeypatch.setattr(transport._transport, "handle_async_request", fake_send)
        async with httpx.AsyncClient(transport=transport) as client:
            assert (await client.get("https://example.org/")).status_code == 200
        return requested

    assert asyncio.run(run()) == ["1.1.1.1", "8.8.8.8"]


def test_discovered_resource_url_is_checked(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 80))
    ])
    with pytest.raises(UnsafeScanDestination):
        _pinned_request(httpx.Request("GET", "http://metadata.example/secret"))


def test_proxy_is_given_pinned_ip(monkeypatch):
    monkeypatch.setenv("OUTBOUND_PROXY_URL", "socks5://vpn:1080")
    transport = SafeScanTransport()
    try:
        assert transport._transport._pool._proxy_url.host == b"vpn"
    finally:
        transport.close()


@pytest.mark.parametrize("cidr", ["127.0.0.0/8", "10.0.0.0/8", "169.254.0.0/16", "fc00::/7", "::/0"])
def test_optional_raw_range_scan_rejects_non_public_ranges(cidr):
    with pytest.raises(UnsafeScanDestination):
        _validate_scan_cidrs([cidr])
    _validate_scan_cidrs(["1.1.1.0/24"])


def test_ssh_keyscan_fallback_never_receives_unvalidated_host(monkeypatch):
    monkeypatch.setattr(signal_transport.shutil, "which", lambda *_args: "/usr/bin/ssh-keyscan")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 22))
    ])
    monkeypatch.setattr(signal_transport.subprocess, "run", lambda *_args, **_kwargs: pytest.fail("SSH subprocess started"))
    assert signal_transport._grab_ssh_host_keys_ssh_keyscan("internal.example", port=22, timeout=1) == []


def test_ssh_keyscan_fallback_tries_next_validated_address(monkeypatch):
    monkeypatch.setattr(signal_transport.shutil, "which", lambda *_args: "/usr/bin/ssh-keyscan")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 22)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 22)),
    ])
    seen = []

    def fake_run(args, **_kwargs):
        seen.append(args[-1])
        return type("Result", (), {"stdout": "" if len(seen) == 1 else "8.8.8.8 ssh-ed25519 AAAA"})()

    monkeypatch.setattr(signal_transport.subprocess, "run", fake_run)
    signal_transport._grab_ssh_host_keys_ssh_keyscan("example.org", port=22, timeout=1)
    assert seen == ["1.1.1.1", "8.8.8.8"]


class _RecordingProxyStream:
    def __init__(self):
        self.writes = []
        self.tls_hosts = []
        self.responses = [
            b"HTTP/1.1 200 Connection established\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
        ]

    def read(self, _max_bytes, timeout=None):
        return self.responses.pop(0) if self.responses else b""

    def write(self, buffer, timeout=None):
        self.writes.append(buffer)

    def start_tls(self, _ssl_context, server_hostname=None, timeout=None):
        self.tls_hosts.append(server_hostname)
        return self

    def close(self):
        pass

    def get_extra_info(self, _info):
        return None


@pytest.mark.parametrize("scheme,expected_tls", [
    ("http", ["example.org"]),
    ("https", ["proxy.example", "example.org"]),
])
def test_http_proxy_connects_to_ip_but_verifies_original_hostname(monkeypatch, scheme, expected_tls):
    monkeypatch.setenv("OUTBOUND_PROXY_URL", f"{scheme}://proxy.example:8888")
    monkeypatch.setattr(scan_destination, "resolve_public_addresses", lambda *_args: ("1.1.1.1",))
    stream = _RecordingProxyStream()

    class Backend:
        def connect_tcp(self, **_kwargs):
            return stream

    transport = SafeScanTransport()
    transport._transport._pool._network_backend._backend = Backend()
    with httpx.Client(transport=transport) as client:
        assert client.get("https://example.org/path").status_code == 200
    writes = b"".join(stream.writes)
    assert b"CONNECT 1.1.1.1:443 HTTP/1.1" in writes
    assert b"host: example.org" in writes.lower()
    assert stream.tls_hosts == expected_tls


def test_async_http_proxy_preserves_target_tls_name(monkeypatch):
    monkeypatch.setenv("OUTBOUND_PROXY_URL", "http://proxy.example:8888")

    async def addresses(*_args):
        return ("1.1.1.1",)

    monkeypatch.setattr(scan_destination, "async_resolve_public_addresses", addresses)
    recording = _RecordingProxyStream()

    class Stream:
        async def read(self, max_bytes, timeout=None):
            return recording.read(max_bytes, timeout)

        async def write(self, buffer, timeout=None):
            recording.write(buffer, timeout)

        async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            recording.start_tls(ssl_context, server_hostname, timeout)
            return self

        async def aclose(self):
            pass

        def get_extra_info(self, info):
            return recording.get_extra_info(info)

    class Backend:
        async def connect_tcp(self, **_kwargs):
            return Stream()

    async def run():
        transport = AsyncSafeScanTransport()
        transport._transport._pool._network_backend._backend = Backend()
        async with httpx.AsyncClient(transport=transport) as client:
            assert (await client.get("https://example.org/path")).status_code == 200

    asyncio.run(run())
    assert b"CONNECT 1.1.1.1:443 HTTP/1.1" in b"".join(recording.writes)
    assert recording.tls_hosts == ["example.org"]


def test_http_proxy_keeps_concurrent_hostnames_separate(monkeypatch):
    monkeypatch.setenv("OUTBOUND_PROXY_URL", "http://proxy.example:8888")
    monkeypatch.setattr(scan_destination, "resolve_public_addresses", lambda *_args: ("1.1.1.1",))
    streams = []

    class Backend:
        def connect_tcp(self, **_kwargs):
            stream = _RecordingProxyStream()
            streams.append(stream)
            return stream

    transport = SafeScanTransport()
    transport._transport._pool._network_backend._backend = Backend()
    with httpx.Client(transport=transport) as client:
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert list(pool.map(lambda host: client.get(f"https://{host}/").status_code, ["first.example", "second.example"])) == [200, 200]
    assert len(streams) == 2
    for stream in streams:
        writes = b"".join(stream.writes)
        host = "first.example" if b"host: first.example" in writes.lower() else "second.example"
        assert stream.tls_hosts == [host]
