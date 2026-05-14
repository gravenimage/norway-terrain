"""Serve the viewer locally, reconstituting data files first if needed.

Usage:
    uv run serve.py             # default port 8000
    uv run serve.py --port 8080

Equivalently:
    python serve.py
"""
from __future__ import annotations

import argparse
import errno
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

import reconstitute

ROOT = Path(__file__).resolve().parent

MAX_PORT_TRIES = 20


class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded HTTP server so tile/asset requests can be served concurrently.

    The default ``socketserver.TCPServer`` handles one request at a time, which
    causes the browser's parallel tile fetches to stall when many tiles are
    requested at once (visible as slow load times in normal use and timeouts in
    automated Playwright tests).
    """

    daemon_threads = True
    allow_reuse_address = True


def _bind_server(start_port: int, handler) -> tuple[socketserver.TCPServer, int]:
    """Try to bind starting at start_port, falling back to the next available port."""
    last_err: OSError | None = None
    for offset in range(MAX_PORT_TRIES):
        port = start_port + offset
        try:
            httpd = _ThreadingHTTPServer(("", port), handler)
        except OSError as exc:
            if exc.errno in (errno.EADDRINUSE, errno.EACCES, getattr(errno, "WSAEADDRINUSE", 10048)):
                print(f"  port {port} is in use, trying {port + 1} ...", flush=True)
                last_err = exc
                continue
            raise
        return httpd, port
    raise RuntimeError(
        f"Could not find an available port in range {start_port}..{start_port + MAX_PORT_TRIES - 1}"
    ) from last_err


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000, help="Preferred port (default: 8000); falls back to next free port if busy")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open the viewer in a browser")
    args = parser.parse_args()

    print("Step 1/2: checking data files ...", flush=True)
    reconstitute.run()

    print(f"\nStep 2/2: starting local server (preferred port {args.port}) ...", flush=True)

    handler = http.server.SimpleHTTPRequestHandler
    try:
        httpd, port = _bind_server(args.port, handler)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    if port != args.port:
        print(f"  (port {args.port} was busy; using {port} instead)", flush=True)
    print(f"\nServing on http://localhost:{port}/", flush=True)
    print(f"  viewer:  http://localhost:{port}/viewer.html", flush=True)
    print(f"  preview: http://localhost:{port}/index.html", flush=True)
    print("Press Ctrl+C to stop.\n", flush=True)

    try:
        with httpd:
            if not args.no_browser:
                try:
                    webbrowser.open(f"http://localhost:{port}/viewer.html")
                except Exception:
                    pass
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
