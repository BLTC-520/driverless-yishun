"""Build the static site: web/src (page fragment + app.js) + web/public/data -> web/dist.

* dist/index.html the landing page (home.html): a drive recorded in the game loops behind two ways
                  in, the study and the game, with its headline numbers pre-filled
* dist/evidence.html the checks, the charts behind them, the data files and provenance (evidence.js)
* dist/play.html  the game (Night Shift: play.html + play.js with physics.js and shaders.js)
* dist/study.html the study (Phase 1 chapters and the Phase 2 chapter, phase2.js), wrapped in a full HTML document, for standalone hosting
                  (GitHub Pages, `python -m http.server`)
* dist/page.html  the study as a page fragment with headline numbers pre-filled from the data (what
                  the artifact host publishes; it supplies the document skeleton itself)
* dist/models/    vehicle models (glTF) built in Blender by tools/blender/build_models.py
* dist/media/     the landing page's background drive, recorded by web/record_loop.py
The numbers are filled again at runtime by app.js from the same JSON files.
Usage: python web/build.py
"""
from __future__ import annotations

import html
import json
import re
import shutil
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC, DATA, DIST = ROOT / "src", ROOT / "public" / "data", ROOT / "dist"
MODELS = ROOT / "public" / "models"  # vehicle .glb files from tools/blender/build_models.py
MEDIA = ROOT / "public" / "media"    # the landing page's background video, from web/record_loop.py
FILL = re.compile(r'(data-v="([a-z0-9_]+)">)—(</(?:span|td|b)>)')

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%230c111b'/%3E%3Ccircle cx='8' cy='8' r='4' fill='%23f2a53a'/%3E%3C/svg%3E">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
"""


def numbers() -> dict[str, str]:
    """The page's quoted numbers, formatted once by the pipeline (results.json "numbers", and the
    Phase 2 chapter's phase2.json "numbers" when present), so the first frame shows real figures;
    app.js and phase2.js fill the same values at runtime."""
    rs = json.loads((DATA / "results.json").read_text())
    vals = dict(rs.get("numbers", {}))
    if rs.get("frontier_audit"):   # the evidence page's monotonicity check
        vals["audit_checked"] = f"{rs['frontier_audit']['checked']:,}"
        vals["audit_viol"] = "no" if rs["frontier_audit"]["violations"] == 0 else f"{rs['frontier_audit']['violations']:,}"
    p2 = DATA / "phase2.json"
    if p2.exists():
        vals = {**vals, **json.loads(p2.read_text()).get("numbers", {})}
    return vals


P2_IMG = ROOT.parent / "docs" / "phase2" / "img"  # matplotlib charts from yishun.phase2.charts, with captions.md
P2_TITLES = {
    "tradeoff.png": "Every configuration: cost against time saved",
    "tradeoff_staffing.png": "The best saving for the cost, by staffing",
    "budget.png": "What a budget buys",
    "cost_classes.png": "Where the shuttle cost goes",
    "passenger_time.png": "Passenger time, waiting and in vehicle",
    "periods.png": "When the time is saved",
    "tornado.png": "Which cost parameters move the answer",
}
P2_WIDE = {"tradeoff.png", "tornado.png"}


def phase2_figures() -> str:
    """The Phase 2 charts as <figure>s for the evidence page, captions taken from captions.md so they cannot drift."""
    caps = {}
    for block in re.split(r"^## ", (P2_IMG / "captions.md").read_text(), flags=re.M)[1:]:
        name, _, rest = block.partition("\n")
        caps[name.strip()] = [ln for ln in rest.splitlines() if ln.strip() and not ln.startswith("![")][0]
    out = []
    for name, title in P2_TITLES.items():
        w, h = struct.unpack(">II", (P2_IMG / name).read_bytes()[16:24])
        cls = ' class="wide"' if name in P2_WIDE else ""
        out.append(
            f'      <figure{cls}><h3>{html.escape(title)}</h3>'
            f'<a href="img/phase2/{name}"><img src="img/phase2/{name}" width="{w}" height="{h}" loading="lazy" alt="{html.escape(title)}"></a>'
            f'<figcaption>{html.escape(caps[name])}</figcaption></figure>'
        )
    return "\n".join(out)


def main() -> None:
    page = (SRC / "index.html").read_text()
    try:
        vals = numbers()
        page = FILL.sub(lambda m: m.group(1) + vals.get(m.group(2), "—") + m.group(3), page)
        rs = json.loads((DATA / "results.json").read_text())
        page = page.replace('<span id="who-text">—</span>', f'<span id="who-text">{rs["who"]["text"]}</span>')
        if rs["who"].get("headline"):
            page = page.replace('<h2 id="who-h2">Who gains, and who does not</h2>', f'<h2 id="who-h2">{rs["who"]["headline"]}</h2>')
    except FileNotFoundError as e:
        print(f"numbers not pre-filled ({e})")
    DIST.mkdir(exist_ok=True)
    (DIST / "page.html").write_text(page)
    cut = page.index("<header")
    (DIST / "study.html").write_text(HEAD + page[:cut] + "</head>\n<body>\n" + page[cut:] + "\n</body>\n</html>\n")
    shutil.copy(SRC / "app.js", DIST / "app.js")
    shutil.copy(SRC / "phase2.js", DIST / "phase2.js")
    shutil.copy(SRC / "evidence.js", DIST / "evidence.js")
    shutil.copy(SRC / "charts.js", DIST / "charts.js")   # the shared ECharts set-up for phase2.js and evidence.js
    for name in ("play.js", "physics.js", "shaders.js"):  # the game and its modules
        shutil.copy(SRC / name, DIST / name)
    shutil.copy(SRC / "play.html", DIST / "play.html")
    home = (SRC / "home.html").read_text()
    try:
        vals = numbers()
        home = FILL.sub(lambda m: m.group(1) + vals.get(m.group(2), "—") + m.group(3), home)
    except FileNotFoundError as e:
        print(f"landing numbers not pre-filled ({e})")
    (DIST / "index.html").write_text(home)
    ev = (SRC / "evidence.html").read_text()   # the evidence page: checks, charts, files, provenance
    try:
        vals = numbers()
        ev = FILL.sub(lambda m: m.group(1) + vals.get(m.group(2), "—") + m.group(3), ev)
    except FileNotFoundError as e:
        print(f"evidence numbers not pre-filled ({e})")
    ev = ev.replace("<!--phase2-figures-->", phase2_figures())
    (DIST / "evidence.html").write_text(ev)
    if (DIST / "img").exists():
        shutil.rmtree(DIST / "img")
    (DIST / "img" / "phase2").mkdir(parents=True)
    for name in P2_TITLES:
        shutil.copy(P2_IMG / name, DIST / "img" / "phase2" / name)
    if (DIST / "data").exists():
        shutil.rmtree(DIST / "data")
    shutil.copytree(DATA, DIST / "data")
    if (DIST / "models").exists():
        shutil.rmtree(DIST / "models")
    shutil.copytree(MODELS, DIST / "models")
    if (DIST / "media").exists():
        shutil.rmtree(DIST / "media")
    if MEDIA.exists():
        shutil.copytree(MEDIA, DIST / "media")
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"built {DIST} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
