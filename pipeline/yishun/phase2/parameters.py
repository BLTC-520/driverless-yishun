"""Merge the two evidence proposals (data/parameters/proposed_av.json, proposed_sg.json) into the
parameter file the cost model reads (cost_cases.json) and one source register (cost_register.csv).
Prints overlaps, gaps and schema problems; writes only with --write. The lead's decisions on
conflicting evidence are listed in the file's "decisions".

Usage (from pipeline/): python -m yishun.phase2.parameters [--write]
"""
import copy
import csv
import json
import sys

from .. import costs
from ..paths import ROOT
P = ROOT / "data" / "parameters"
av, sg = json.loads((P / "proposed_av.json").read_text()), json.loads((P / "proposed_sg.json").read_text())
regs = []
for f in ("register_av.csv", "register_sg.csv"):
    with open(P / f, newline="") as fh:
        regs.append((f, list(csv.DictReader(fh))))
ids = [r["source_id"] for _, rows in regs for r in rows]
print("register rows", len(ids), "duplicate ids", sorted({i for i in ids if ids.count(i) > 1}))
both = sorted(set(av["parameters"]) & set(sg["parameters"]))
print("in both proposals:", both)
merged = {}
for src in (av, sg):
    for k, e in src["parameters"].items():
        if k in costs.KNOWN_IDS:
            merged.setdefault(k, copy.deepcopy(e))
decisions = [
    "Union of proposed_av.json (shuttle side) and proposed_sg.json (Singapore and bus side); ids outside "
    "definitions.md section 8 are kept only where the cost model uses them (vehicles_per_monitor_onboard_mode).",
    "Switches from the AV proposal: purchase; staff_mode onboard = the current pilot requirement. The summary "
    "reports both staff modes side by side and never mixes them into one range.",
]
if "cleaning_sgd_per_vehicle_day" in both:
    a, s = av["parameters"]["cleaning_sgd_per_vehicle_day"], sg["parameters"]["cleaning_sgd_per_vehicle_day"]
    e = copy.deepcopy(s)
    for c in ("4", "10", "20"):
        e["by_capacity"][c]["high_cost"] = max(s["by_capacity"][c]["high_cost"], a["by_capacity"][c]["high_cost"])
    e["sources"] = sorted(set(s["sources"]) | set(a["sources"]))
    e["note"] = ("Lead merge: low and central from the wage-based Singapore proposal (" + s["note"][:180] +
                 "...); high from the AV proposal's longer in-day checks of an unattended vehicle (" + a["note"][:160] + "...).")
    merged["cleaning_sgd_per_vehicle_day"] = e
    decisions.append("cleaning_sgd_per_vehicle_day: low and central from the Singapore proposal (wage-based); high "
                     "from the AV proposal (extra in-day checks of an unattended vehicle).")
missing = [k for k in costs.SHUTTLE_IDS + costs.SOCIAL_IDS if k not in merged]
print("missing ids:", missing)
out = {"currency": "SGD", "price_year": 2026, "days_per_year": 365, "gst": "excluded",
       "status": "Lead-approved merge of the two evidence proposals (23 Oct 2026). Sources: cost_register.csv; "
                 "notes: docs/phase2/sources_av.md, docs/phase2/sources_sg.md.",
       "decisions": decisions, "parameters": merged,
       "switches": av.get("switches", {"acquisition": "purchase", "staff_mode": "onboard", "lease_includes": []})}
err = costs.validate_cases(out, register_ids=ids)
print("validation problems:", len(err)); print("\n".join(err[:40]))
if "--write" in sys.argv and not err:
    (P / "cost_cases.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    cols = list(regs[0][1][0].keys())
    with open(P / "cost_register.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols); w.writeheader()
        for _, rows in regs:
            w.writerows(rows)
    print("written")
