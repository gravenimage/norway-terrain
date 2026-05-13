"""Top-down screenshot of viewer.html for verifying shader-based road overlay.

Usage:
    uv run --with playwright --with pillow python tests/roads_screenshot.py [name]

Writes:
    tests/_artifacts/roads_<name>.png            — viewport screenshot
    tests/_artifacts/roads_<name>_console.txt    — console log

Expects a dev server on http://localhost:8765/.
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "tests" / "_artifacts"
ART.mkdir(exist_ok=True)


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "topdown"
    url = "http://localhost:8765/viewer.html"

    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--use-gl=angle",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
        ])
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
        page = ctx.new_page()
        msgs: list[str] = []
        page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))
        try:
            page.goto(url, wait_until="domcontentloaded")
            # Wait for the road spatial-grid to be built.
            page.wait_for_function("() => !!window.__roadGrid && !!window.__viewer", timeout=60_000)
            info = page.evaluate("""() => {
                const g = window.__roadGrid;
                // find densest cell
                let maxC=0, maxI=0;
                for (let i=0;i<g.gridData.length;i+=2){
                    const c = g.gridData[i+1];
                    if (c > maxC){ maxC = c; maxI = i/2; }
                }
                const cx = maxI % g.gridW, cy = Math.floor(maxI / g.gridW);
                const wx = g.xMinC + (cx + 0.5) * g.cell;
                const wy = g.yMinC + (cy + 0.5) * g.cell;
                return {gridW: g.gridW, gridH: g.gridH, N: g.N, totalRefs: g.totalRefs, maxCellCount: g.maxCellCount, denseCellX: cx, denseCellY: cy, denseWx: wx, denseWy: wy, cell: g.cell, xMinC: g.xMinC, yMinC: g.yMinC};
            }""")
            print("road grid:", info)
            # Position camera ~3km up looking straight down at densest road area.
            tx = info["denseWx"]
            ty = info["denseWy"]
            alt = 3000
            if len(sys.argv) > 2:
                tx = int(sys.argv[2])
            if len(sys.argv) > 3:
                ty = int(sys.argv[3])
            if len(sys.argv) > 4:
                alt = int(sys.argv[4])
            print(f"camera target: ({tx},{ty}) alt={alt}")
            page.evaluate(
                """({tx, ty, alt}) => {
                    const v = window.__viewer;
                    v.controls.target.set(tx, ty, 0);
                    v.camera.position.set(tx, ty, alt);
                    v.camera.up.set(0, 1, 0);
                    v.camera.lookAt(tx, ty, 0);
                    v.controls.update();
                }""",
                {"tx": tx, "ty": ty, "alt": alt},
            )
            # Let the scene render + new tiles to load at this zoom.
            page.wait_for_timeout(8000)
            out = ART / f"roads_{name}.png"
            page.screenshot(path=str(out), full_page=False, timeout=120_000)
            print(f"wrote {out}")
        finally:
            (ART / f"roads_{name}_console.txt").write_text("\n".join(msgs))
            browser.close()


if __name__ == "__main__":
    main()
