"""Screenshot the built site (web/dist) in headless Chromium for QA and the README.

Usage: python web/screenshot.py [out_dir]
Serves web/dist on a local port, opens it at desktop and phone widths, waits for the map
to render, pauses playback at a fixed time, and saves PNGs. Console errors are printed.
"""
from __future__ import annotations

import glob
import http.server
import sys
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "docs" / "img"


def serve() -> int:
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    port = serve()
    exe = (glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome") or [None])[0]
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe, args=["--use-gl=angle", "--use-angle=swiftshader",
                                                          "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        for name, vp in (("desktop", {"width": 1440, "height": 1000}), ("phone", {"width": 400, "height": 860})):
            page = b.new_page(viewport=vp, device_scale_factor=1)
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{port}/study.html#still", wait_until="networkidle")
            page.wait_for_function("document.documentElement.dataset.ready === '1'", timeout=180_000)
            # a reproducible frame at 07:45
            page.evaluate("""() => { const t = document.getElementById('time'); t.value = '465';
                t.dispatchEvent(new Event('input')); window.scrollTo(0, 0); }""")
            page.wait_for_timeout(4000)
            box = page.evaluate("""() => { const r = document.getElementById('stage').getBoundingClientRect();
                return {x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height}; }""")
            page.screenshot(path=str(OUT / f"stage_{name}.png"), clip=box, full_page=True)
            try:
                page.screenshot(path=str(OUT / f"page_{name}.png"), full_page=True, timeout=90_000,
                                animations="disabled")
            except Exception as e:  # very tall pages with a live WebGL canvas can time out
                print(f"{name}: full-page capture skipped ({type(e).__name__})")
                page.screenshot(path=str(OUT / f"view_{name}.png"))
            # each chapter on its own, for checking charts and tables
            for sid in ("cliff", "cost", "kerb", "who", "phase2", "method"):
                try:
                    el = page.locator(f"#{sid}")
                    el.scroll_into_view_if_needed(timeout=10_000)
                    page.wait_for_timeout(300)
                    el.screenshot(path=str(OUT / f"sec_{sid}_{name}.png"), timeout=30_000, animations="disabled")
                except Exception as e:
                    print(f"{name}: section {sid} skipped ({type(e).__name__})")
            overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
            print(f"{name}: console errors={errors[:5]} horizontal_overflow={overflow}")
            page.close()
        b.close()
    print(f"saved to {OUT}")


if __name__ == "__main__":
    main()
