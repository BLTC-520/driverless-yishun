"""Build the static site: web/src (page fragment + app.js) + web/public/data -> web/dist.

* dist/page.html  the page fragment with headline numbers pre-filled from the data (what the
                  artifact host publishes; it supplies the document skeleton itself)
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

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
"""


def numbers() -> dict[str, str]:
    """The same values app.js#fillNumbers computes, so the first frame shows real figures."""
    j = lambda n: json.loads((DATA / n).read_text())  # noqa: E731
    dm, bl, rs = j("demand.json"), j("baseline.json"), j("results.json")
    cal = bl["calibration"]
    pad = lambda h: f"{h:02d}"  # noqa: E731
    return {
        "rides": f"{dm['rides_per_weekday']:,}", "pairs": f"{dm['od_pairs']:,}",
        "median": f"{dm['straight_line_pct_m']['50'] / 1000:.2f} km", "hubshare": f"{round(100 * dm['hub_share'])}%",
        "frontier": f"{rs['frontier_peak']['10']['fleet']:,}", "feeders": f"{max(bl['feeder_buses_on_road']):,}",
        "vkm": f"{rs['reference']['veh_km']:,.0f}", "buskm": f"{bl['bus_km_inside_day']:,}",
        "feederkm": f"{bl['feeder_bus_km_inside_day']:,}",
        "vkmx": f"{rs['reference']['veh_km'] / bl['bus_km_inside_day']:.1f}×",
        "kerbmax": f"{max(v for v in rs['reference']['kerb']['Yishun'] if v is not None):.0f}",
        "kerbkhatib": f"{max(v for v in rs['reference']['kerb'].get('Khatib', [0]) if v is not None):.0f}",
        "calobs": f"{cal['n_obs_used']:,}",
        "calhours": f"{pad(cal['hours_sgt'][0])}:00–{pad(cal['hours_sgt'][-1] + 1)}:00",
        "sig": f"{cal['sig_s']:.0f}", "dwell": f"{cal['dwell_s']:.0f}", "hubx": f"{cal['hub_extra_s']:.0f}",
        "kappa": f"{cal['kappa']:.2f}", "cliffgap": f"{rs['cliff_gap']:,}" if rs.get("cliff_gap") else "—",
    }


def main() -> None:
    page = (SRC / "index.html").read_text()
    try:
        vals = numbers()
        page = re.sub(r'(data-v="([a-z0-9]+)">)—(</span>)',
                      lambda m: m.group(1) + vals.get(m.group(2), "—") + m.group(3), page)
        rs = json.loads((DATA / "results.json").read_text())
        page = page.replace('<span id="who-text">—</span>', f'<span id="who-text">{rs["who"]["text"]}</span>')
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
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"built {DIST} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
