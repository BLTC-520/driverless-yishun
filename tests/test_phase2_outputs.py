"""Phase 2 outputs agree with each other: runs -> summary.json -> page data and results tables.

These read the committed outputs (skipped when they are absent, e.g. before the first run), so a
stale export or a hand-edited table fails here rather than reaching the report.
"""
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from yishun.phase2 import export_web, report_tables  # noqa: E402

SUMMARY = ROOT / "data" / "processed" / "phase2" / "summary.json"
pytestmark = pytest.mark.skipif(not SUMMARY.exists(), reason="no Phase 2 summary yet")


@pytest.fixture(scope="module")
def S():
    return json.loads(SUMMARY.read_text())


def test_every_grid_ran_on_a_clean_tree_with_one_model(S):
    runs = S["provenance"]["grid_runs"]
    assert set(runs) == set(S["provenance"]["grids"])
    assert all(not g["pipeline_modified"] for g in runs.values())
    assert len({g["model_key"] for g in runs.values()}) == 1 and len({g["git"] for g in runs.values()}) == 1
    assert {g["model_key"] for g in runs.values()} == {S["provenance"]["model_key"]}


def test_headline_savings_match_the_run_files(S):
    """Recompute the reference options' saving from runs.parquet: mean over seeds of A's minus the
    option's passenger-hours, base scenario, one row per run (a run repeated in a later grid counts once)."""
    out = ROOT / "data" / "processed" / "phase2"
    r = pd.concat([pd.read_parquet(out / g / "runs.parquet").assign(order=k) for k, g in enumerate(S["provenance"]["grids"])
                   if g != "stress"]).sort_values("order").drop_duplicates("run_id", keep="last")
    r = r[(r.scenario == "base") & (r.availability == 1.0) & (r.berths == -1)]
    cfg = {c["id"]: c for c in S["configs"]}
    for i in S["reference_ids"]:
        c = cfg[i]
        if c["option"] == "A":
            continue
        m = (r.option == c["option"]) & (r.capacity == c["capacity"]) & (r.fleet == c["fleet"]) & (r.w_max_s == c["w_max_s"])
        m &= r.theta_min.isna() if c.get("theta_min") is None else (r.theta_min == c["theta_min"])
        m &= r.hours.fillna("") == (c.get("hours") or "")
        sel = r[m]
        assert len(sel) == c["n_seeds"] and sel.seed.nunique() == c["n_seeds"]
        assert (sel.pax_h_A - sel.pax_h).mean() == pytest.approx(c["saved_h"], rel=1e-9)
        assert sel.n_refused.mean() == pytest.approx(c["n_refused"], abs=1e-9)


def test_page_data_is_the_current_export(S):
    built = export_web.build(S)
    on_disk = json.loads(export_web.OUT.read_text())
    assert on_disk == json.loads(json.dumps(built))
    assert not built["synthetic"]


def test_page_numbers_quote_the_summary(S):
    P = export_web.build(S)
    cfg = {c["id"]: c for c in S["configs"]}
    b = P["refs"]["B"]
    assert P["numbers"]["p2_b_saved"] == f"{round(cfg[b]['saved_h']):,}"
    for m in P["modes"]:
        for i in [b, *P["refs"]["C"]]:
            row = next(x for x in S["costs"] if x["id"] == i and x["staff_mode"] == m and x["case"] == "central"
                       and x["bus_case"] == export_web.KEPT)
            assert P["costs"][m][i]["delta_cost"]["central"] == round(row["delta_cost"])
        # only configurations with acceptable service are on the frontier
        assert all(cfg[i]["acceptable"] for case in ("low", "central", "high") for i in P["frontier"][m][case])


def test_results_tables_are_current(S):
    assert report_tables.OUT.read_text() == report_tables.build(S)
