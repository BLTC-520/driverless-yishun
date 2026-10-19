"""Build the static site: web/src (page fragment + app.js) + web/public/data -> web/dist.

* dist/page.html  the page fragment with headline numbers pre-filled from the data (what the
                  artifact host publishes; it supplies the document skeleton itself)
* dist/models/    vehicle models (glTF) built in Blender by tools/blender/build_models.py
* dist/index.html the same page wrapped in a full HTML document, for standalone hosting
                  (GitHub Pages, `python -m http.server`)
The numbers are filled again at runtime by app.js from the same JSON files.
Usage: python web/build.py
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC, DATA, DIST = ROOT / "src", ROOT / "public" / "data", ROOT / "dist"
MODELS = ROOT / "public" / "models"  # vehicle .glb files from tools/blender/build_models.py

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%230c111b'/%3E%3Ccircle cx='8' cy='8' r='4' fill='%23f2a53a'/%3E%3C/svg%3E">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
"""


def numbers() -> dict[str, str]:
    """The page's quoted numbers, formatted once by the pipeline (results.json "numbers"), so the
    first frame shows real figures; app.js fills the same values at runtime."""
    return json.loads((DATA / "results.json").read_text()).get("numbers", {})


def main() -> None:
    page = (SRC / "index.html").read_text()
    try:
        vals = numbers()
        page = re.sub(r'(data-v="([a-z0-9_]+)">)—(</(?:span|td)>)',
                      lambda m: m.group(1) + vals.get(m.group(2), "—") + m.group(3), page)
        rs = json.loads((DATA / "results.json").read_text())
        page = page.replace('<span id="who-text">—</span>', f'<span id="who-text">{rs["who"]["text"]}</span>')
        if rs["who"].get("headline"):
            page = page.replace('<h2 id="who-h2">Who gains, and who does not</h2>', f'<h2 id="who-h2">{rs["who"]["headline"]}</h2>')
    except FileNotFoundError as e:
        print(f"numbers not pre-filled ({e})")
    DIST.mkdir(exist_ok=True)
    (DIST / "page.html").write_text(page)
    cut = page.index("<header")
    (DIST / "index.html").write_text(HEAD + page[:cut] + "</head>\n<body>\n" + page[cut:] + "\n</body>\n</html>\n")
    shutil.copy(SRC / "app.js", DIST / "app.js")
    if (DIST / "data").exists():
        shutil.rmtree(DIST / "data")
    shutil.copytree(DATA, DIST / "data")
    if (DIST / "models").exists():
        shutil.rmtree(DIST / "models")
    shutil.copytree(MODELS, DIST / "models")
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"built {DIST} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
