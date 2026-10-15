# Validation

What was checked, how, and what it showed. "Pass" means the check ran and met its stated
criterion. Weaknesses that remain are listed at the end.

## Research validity

| Claim used in the framing | Check | Result |
|---|---|---|
| Singapore's AV deployment is fleet shuttles for intra-town connectivity | Primary sources: LTA releases of 4 Mar 2026 and 29 Jul 2026 | Verified. On-demand direct-routing pilot by Grab in Punggol; more than 11,500 riders by 12 Jul 2026 |
| Autonomous public-bus pilot (services 400, 191) paused in Oct 2026 | News report (Mothership, 13 Oct 2026) quoting LTA | Verified against a secondary source; LTA's own statement not located |
| Junction counts too sparse for traffic calibration | Downloaded the DataMall Traffic Count archive and indexed it | 60 Yishun workbooks at 31 sites, one-day surveys from 2017 to Jan 2024 |
| Closest prior work: Shen, Zhang & Zhao 2018 | Crossref/DOI metadata plus a secondary review | One low-demand area, 2-hour AM peak, assumed mode split, up to 35 vehicles |
| Two research agents disagreed on which dataset holds the Census 2020 age table | Opened the file | `d_d95ae740…` is the planning-area × age table (Singapore total 4,044,210; Yishun 221,610) |

## Data validity

- **Demand.** Internal rides sum to about 158,000 per weekday. 67.6 % touch a station stop,
  and the hourly profile has the expected AM and PM peaks.
  - Uncovered rides: 1.2 % of observed rides have no direct bus line in the baseline model,
    almost all at 05:00, before scheduled first buses. Tested: < 2 % at midday.
- **Stops.** All 180 study stops snap to a drivable edge, median 7 m away.
  - Three snap 30–51 m away (the interchange driveway and two stops on Yishun Ring Road).
- **Census age.** The nine subzone rows sum to the planning-area total.

## Network validity

- **Routed vs published distances.** Across 268 consecutive stop pairs on LTA bus routes,
  routed distance divided by LTA's published distance has a median of 1.02 and an IQR of
  0.95–1.09.
  - 11 pairs (4 %) are off by more than 50 %. Some are LTA's 0.1 km rounding on short
    segments; some are snapping or topology errors.
  - Segments off by more than 40 % are excluded from calibration (198 of 1,490 sequences).
- **Routing tables.** Stop→stop times and distances from the routing tables equal an
  independent networkx computation (max |ΔT| = 0 s, max |ΔD| = 0 m). Times reconstructed
  along node paths agree to 1e-12 s.

## Model validity

- **Calibration fit.** On about 250,000 matched observations covering 1,311 stop sequences of
  one to six stops: r = 0.96, mean absolute error 36 s against a mean observed time of 288 s.
  All four parameters have bootstrap intervals that exclude zero.
- **Synthetic recovery.** The estimator recovers known parameters within 12 %, with the truth
  inside every bootstrap interval (`tests/test_models.py`).
- **Bus baseline.**
  - Measured headway regularity gives κ = 0.557, slightly better for buses than the textbook
    0.625 at CV 0.5.
  - Observed mean headways agree with LTA's published bands.
  - Modelled feeder loop times are 1.0–1.3× LTA's scheduled first/last-bus offsets. Three
    entries are data quirks in LTA's per-stop first/last-bus fields.
- **Common-lines arithmetic.** Unit-tested on a two-line case.

## Engineering validity

- **Insertion kernel vs brute force.** The numba kernel equals an explicit enumeration of every
  insertion on 382 random schedules: same optimal cost, and the kernel's chosen insertion is
  feasible with exactly the reported times.
- **Simulator.**
  - Exact times on a grid network.
  - Capacity-1 riders are serialised; same-destination riders pool.
  - Capacity is never exceeded.
  - Every vehicle's legs are sequential.
  - Same seed gives the same result.
- **Runtime.** A full weekday (about 158,000 requests) simulates in 35–45 s on one CPU core.

## Reproducibility

- **Commands.** `make data` then `make reproduce-core-results` rebuilds calibration,
  experiments and page data from raw inputs.
- **Seeds.** Every simulated day is seeded. Experiments record their job list
  (`config.json`).
- **Not reproducible later.** Live LTA data (bus arrivals, speed bands) cannot be re-downloaded
  for 15 Oct 2026. The derived calibration is committed (`data/processed/calibration.json`),
  and the raw logs can be kept by whoever runs the collectors.

## Known weaknesses

- **Calibration window.** Calibration data covers 10:00–13:00 only, so peak congestion is not
  observed (affects both modes).
- **Bus estimates.** Bus running times are LTA's real-time estimates, not observed passages.
- **Bus crowding.** Denied boarding is not modelled, which favours the bus at peaks.
- **No traffic feedback.** Hundreds of shuttles do not congest roads or kerbs in the model.
- **Dispatcher.** A competent insertion heuristic, not an optimiser. Better dispatch could
  lower the fleet needed.
