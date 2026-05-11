"""Serve the viewer locally, reconstituting data files first if needed.

Usage:
    uv run serve.py             # default port 8000
    uv run serve.py --port 8080

Equivalently:
    python serve.py
"""
from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

import reconstitute

ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000, help="Port to serve on (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open the viewer in a browser")
    args = parser.parse_args()

    print("Step 1/2: checking data files ...", flush=True)
    reconstitute.run()

    print(f"\nStep 2/2: starting local server on http://localhost:{args.port}/", flush=True)
    print(f"  viewer:  http://localhost:{args.port}/viewer.html", flush=True)
    print(f"  preview: http://localhost:{args.port}/index.html", flush=True)
    print("Press Ctrl+C to stop.\n", flush=True)

    handler = http.server.SimpleHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", args.port), handler) as httpd:
            if not args.no_browser:
                try:
                    webbrowser.open(f"http://localhost:{args.port}/viewer.html")
                except Exception:
                    pass
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
