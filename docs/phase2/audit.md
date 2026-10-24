# Phase 2 audit of the Phase 1 baseline

*22 Oct 2026. What was checked before Phase 2 was built, and what it found.*

## Version

- Phase 1 is `main` at `2f749d8` (site and game commits on top of the study). The study results
  in `data/processed/` were computed at `a2ed35a` (fixed-fleet grids) and `96f8c65`–`1abb678`
  (hour windows, kerb, sensitivity), with model key `198908c99fd0`.
- Environment: Python 3.12.3, pinned `requirements.txt`, 4 CPU cores.

## Checks run

| Check | Result |
|---|---|
| Test suite on fresh downloads | 413 passed, 19 skipped by design (capacity-infeasible random schedules); real-network tests ran |
| Internal OD table re-derived from LTA's raw July and August 2026 files | Identical: 59,880 cells, 163,745 rides per weekday, max difference 3e-14 |
| Bus baseline (fresh LTA routes and services of 22 Oct 2026) | Identical to `web/public/data/baseline.json`: hourly times to 0.01 min, 11.97 min day mean, 33,871 bus-km, 152 buses inside Yishun at 07:00, 2,439 bus-hours |
| One Phase 1 run (450 ten-seat shuttles, seed 1) rebuilt | Same demand (164,099 requests) and bus times, but a shuttle mean of 398.3 s against 396.1 s, and at most 0.27 min in any hour |

## The cause: a road graph that depended on the hash seed

- `network.build_drive_graph` decided whether an edge is drivable from the *first* value of
  list-valued OSM tags. osmnx creates these lists when it merges ways (for example a footway that
  continues a residential road) and orders them by set iteration. For strings, that order changes
  with Python's per-process hash seed.
  - On one extract, rebuilding under different `PYTHONHASHSEED` values gave graphs of 5,171 to
    5,195 nodes.
  - The 458 affected edges include 226 footway/steps and 78 footway/service merges.
- Phase 1's experiments are internally consistent: each job ran from the same cached graph.
  - But the graph was a random draw, and neither it nor the OSM extract of 15 Oct 2026 was kept.
  - Overpass dated (attic) queries for 15–18 Oct 2026 did not recover Phase 1's 5,198 nodes and
    8,542 edges, which is expected given the random draw.
- **Fix** (`network.keep_edge`, `network.road_class`, `tests/test_network.py`):
  - An edge is drivable only when every merged part is drivable, unless any part is a bus-only
    link. Its speed class is the slowest part's.
  - A test rebuilds the graph under two hash seeds and requires identical edges.
- **Pinned inputs:**
  - The 22 Oct 2026 OSM extract is committed, xz-compressed with SHA-256 checksums
    (`data/processed/osm/`, ODbL). It is restored with `python -m yishun.fetch_osm pinned`.
  - The model cache key and every result's provenance now carry digests of the raw input files
    and the graph size.
  - Phase 2 graph: 5,171 nodes, 8,482 edges, 158 signal sites, model key `213e91ad1ee8`.

## Phase 1 re-run on the fixed graph

The 96 fixed-fleet runs of Phase 1 (frontier + ext grids, seeds 1–3) were re-run
(`data/processed/phase2/recheck_phase1/`):

| | 4 seats | 10 seats | 20 seats |
|---|---|---|---|
| All-day parity fleet, mean rule (Phase 1 → re-run) | 700 → 700 | 450 → 450 | 375 → 375 |
| Largest failing fleet below it | 650 → 650 | 425 → 425 | 350 → 350 |
| p90 rule | 700 → 700 | 450 → 450 | 375 → 375 |

- At and above the parity fleets, day mean times differ by under 1 s and vehicle-km by under
  0.2 %.
- Near the threshold, single runs differ by up to 12 s (49 s for 275 twenty-seat vehicles),
  because queues there amplify small changes.
- **Phase 1's findings stand.** Phase 2 evaluates every option on the fixed graph and never mixes
  in Phase 1 numbers.

## Existing metrics Phase 2 reuses

- **Passenger time:** bus expected wait and in-vehicle time (common lines, κ = 0.568) and one
  simulated wait per ride; shuttle simulated wait and ride; stop-to-stop boundary; refusals at
  45 min.
- **Vehicle resources:**
  - shuttle vehicle-km (loaded and empty), passenger-km on board, kerb dwell counts by station;
  - bus-km, bus-hours and buses inside Yishun from published headways (`supply.py`).
- **Added for Phase 2:**
  - driving and dwelling vehicle-hours by hour (simulator counters, tested);
  - bus passenger-km shares by rider group (`phase2/bus_allocation.py`).

## Phase 2 modules and parameters

- `phase2/assign.py`: rule C-θ (timetable gap), expected offered demand for repositioning.
- `phase2/runs.py`: one option on one day; per-ride modes; passenger-hours by hour and group.
- `phase2/experiments.py`: grids over θ, fleet, capacity and stress scenarios, on shared seeds.
- `phase2/bus_allocation.py`: who uses in-area bus-km.
- `costs.py`: cost model. Parameters in `data/parameters/cost_cases.json`, sources in
  `data/parameters/cost_register.csv`.
- Parameters needed:
  - Shuttle side: vehicle price/lease, life, residual, discount rate, energy per km, battery,
    charging, electricity price, maintenance, cleaning, insurance and permits, software and
    communications, staff ratios and wages, chargers and depot, spare ratio.
  - Bus side: cost per bus-km and its inclusions.
  - Social side (separate): value of time, waiting weight.
