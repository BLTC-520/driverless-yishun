"""Record the landing page's background: a night drive in Night Shift, as a seamless loop.

Usage: python web/build.py && python web/record_loop.py [--size 1280x720] [--seconds 12] [--workers 4]
Writes web/public/media/nightshift-loop.{webm,mp4,jpg} (VP9, H.264 and a poster frame).

The game runs in headless Chromium on WebGPU (SwiftShader, in software), on autopilot along a road
path from the start at Yishun MRT, with traffic, walkers and lamps as in play. Each frame is stepped
at a fixed rate and read back from a render target (headless browsers cannot capture a WebGPU
canvas), so the clip is smooth however slowly it renders: about 20-40 s a frame in software. Workers
render every n-th frame of the same drive: Math.random is seeded and ?record holds the game still
between steps, so every worker sees the same world. The last second fades into the first, so the
clip loops without a cut. Needs Playwright with its Chromium, Pillow and ffmpeg (libvpx-vp9, libx264).
"""
from __future__ import annotations

import argparse
import base64
import glob
import http.server
import io
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
DIST, MEDIA = ROOT / "dist", ROOT / "public" / "media"
FLAGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader",
         "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-vulkan-surface"]
# Math.random, seeded (mulberry32), so every worker builds and drives the same town
SEEDED = """(() => { let a = %d >>> 0; Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def worker(k: int, a, url: str, frames: Path, total: int) -> None:
    w, h = map(int, a.size.split("x"))
    exe = (glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome") or [None])[0]
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=exe, args=FLAGS)
        pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
        pg.add_init_script(SEEDED % a.seed)
        pg.goto(url)
        pg.wait_for_function("window.__ns", timeout=600_000)
        backend = pg.evaluate(f"(() => {{ const n = window.__ns; n.hour({a.hour}); n.pilot({a.route[0]}, {a.route[1]}, {a.speed}); return n.BACKEND; }})()")
        if backend != "WebGPU":
            print(f"worker {k}: rendering with {backend}", flush=True)
        dt = 1 / a.fps
        pg.evaluate(f"(() => {{ for (let i = 0; i < {round(a.preroll * a.fps)}; i++) window.__ns.step({dt}); }})()")
        t0 = time.time()
        for i in range(total):
            pg.evaluate(f"window.__ns.step({dt})")
            if i % a.workers != k:
                continue
            data = pg.evaluate("window.__ns.snap()")
            Image.open(io.BytesIO(base64.b64decode(data.split(",")[1]))).convert("RGB").save(frames / f"f_{i:04d}.png")
            done = i // a.workers + 1
            if done % 10 == 0:
                print(f"worker {k}: {done}/{total // a.workers} frames, {(time.time() - t0) / done:.0f} s a frame", flush=True)
        b.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--seconds", type=float, default=12, help="length of the loop")
    ap.add_argument("--fade", type=float, default=1, help="seconds the end fades into the start")
    ap.add_argument("--preroll", type=float, default=2.5, help="seconds driven before recording, so traffic and camera settle")
    ap.add_argument("--hour", type=float, default=19.5, choices=[7.5, 13, 19.5, 23])
    ap.add_argument("--route", type=float, nargs=2, default=[483, 60], metavar=("PATH", "METRES"),
                    help="road path (index into paths.json) and where along it to start; 483 runs past Yishun MRT")
    ap.add_argument("--speed", type=float, default=13, help="m/s")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--frames", help="keep the rendered frames in this folder (and reuse any already there)")
    a = ap.parse_args()
    a.route = [int(a.route[0]), a.route[1]]
    if not (DIST / "play.html").exists():
        sys.exit("build the site first: python web/build.py")
    L, X = round(a.seconds * a.fps), round(a.fade * a.fps)
    total = L + X
    frames = Path(a.frames) if a.frames else Path(tempfile.mkdtemp(prefix="nightshift-"))
    frames.mkdir(parents=True, exist_ok=True)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(DIST)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/play.html?record#auto"
    missing = [i for i in range(total) if not (frames / f"f_{i:04d}.png").exists()]
    if missing:
        print(f"rendering {total} frames ({a.size}, {a.fps} fps) with {a.workers} workers into {frames}", flush=True)
        with ThreadPoolExecutor(a.workers) as ex:
            for f in [ex.submit(worker, k, a, url, frames, total) for k in range(a.workers)]:
                f.result()
    # the loop: frames X..L+X, with the last X crossfading from the drive's continuation into its start
    seq = frames / "loop"
    seq.mkdir(exist_ok=True)
    for i in range(L):
        if i < L - X:
            img = Image.open(frames / f"f_{i + X:04d}.png")
        else:
            j = i - (L - X)
            img = Image.blend(Image.open(frames / f"f_{L + j:04d}.png"), Image.open(frames / f"f_{j:04d}.png"), (j + 1) / (X + 1))
        img.save(seq / f"s_{i:04d}.png")
    MEDIA.mkdir(parents=True, exist_ok=True)
    src = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(a.fps), "-i", str(seq / "s_%04d.png"), "-an", "-pix_fmt", "yuv420p"]
    subprocess.run(src + ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "37", "-row-mt", "1", "-deadline", "good", str(MEDIA / "nightshift-loop.webm")], check=True)
    subprocess.run(src + ["-c:v", "libx264", "-crf", "27", "-preset", "slow", "-movflags", "+faststart", str(MEDIA / "nightshift-loop.mp4")], check=True)
    Image.open(seq / "s_0000.png").convert("RGB").save(MEDIA / "nightshift-loop.jpg", quality=82, optimize=True, progressive=True)
    shutil.rmtree(seq)
    if not a.frames:
        shutil.rmtree(frames)
    for f in sorted(MEDIA.glob("nightshift-loop.*")):
        print(f"{f.relative_to(ROOT.parent)}: {f.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
