"""Export the animation scenarios used by the page: today's buses, the reference fleet, an
undersized fleet (the cliff) and the 4-seat fleet that keeps up all day."""
from __future__ import annotations

import json

from .export_anim import export
from .model import build_model
from .paths import WEB_DATA


def main() -> None:
    res = json.loads((WEB_DATA / "results.json").read_text())
    ref, under = res["reference"]["fleet"], int(res["anim"]["undersized"].split("_")[1])
    p4 = res["all_day_parity"].get("4")
    scen = [{"id": f"s10_{ref}", "label": f"{ref} shuttles, 10 seats (keeps up all day)", "capacity": 10, "fleet": ref},
            {"id": f"s10_{under}", "label": f"{under} shuttles, 10 seats (too few)", "capacity": 10, "fleet": under}]
    if p4:
        scen.append({"id": f"s4_{p4}", "label": f"{p4} robotaxis, 4 seats (keeps up all day)", "capacity": 4, "fleet": p4})
    export(build_model(), scen)


if __name__ == "__main__":
    main()
