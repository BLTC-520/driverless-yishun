# Validation

What was checked, how, and what it showed. "Pass" means the check ran and met its stated
criterion. Three fresh reviews (science and claims, engineering, domain expert) red-teamed the
project; what they found and what was done about it is listed at the end.

## Research validity

| Claim used in the framing | Check | Result |
|---|---|---|
| Punggol's autonomous shuttles opened to the public on 1 Apr 2026 for intra-town connectivity | Primary source: LTA release, 4 Mar 2026 | Verified. Includes the quoted purpose and a planned flat fare of $4 |
| Grab pilots on-demand, direct-path rides between existing pick-up points; more than 11,500 riders by 12 Jul 2026 | Primary source: LTA release, 29 Jul 2026 | Verified. Same service type as the simulation: on demand, between fixed points |
| "Today, we only have 16 passenger vehicles, all in Punggol"; point-to-point trial "within the whole estate, without the need for fixed routes"; next towns Tampines North and Tengah | Primary source: MOT speech, 18 Sep 2026 | Verified, quoted exactly |
| LTA stopped a planned autonomous-bus pilot on services 400 and 191 in Oct 2026 | Mothership, 13 Oct 2026 | Verified against a secondary source; LTA confirmed in reply to the publication's questions |
| Junction counts too sparse for traffic calibration | Downloaded the DataMall Traffic Count archive and indexed it | 60 Yishun workbooks at 31 sites, one-day surveys from 2017 to Jan 2024 |
| Closest prior work | Searched | Mo et al. 2021 (TR-C 127, 103058): shared AVs competing with buses, first-mile, Tampines, agent-based with operator equilibrium. Shen, Zhang & Zhao 2018 (TR-A): one low-demand area, 2-hour AM peak. Neither replaces every internal bus ride of a mature town with observed stop-to-stop demand |
| Theory on when demand-responsive feeders beat fixed routes | Li & Quadrifoglio 2010 (TR-C 18(5)) abstract | Critical demand 10–50 riders per sq mile per hour; Yishun at 07:00 is about 2,000 |
| Deployed AV sizes (5-seat robotaxi, 8-seat shuttle) | Operator and trade-press releases, via research agents | Inferred, not verified from a primary LTA source; the 4/10/20-seat cases bracket them |

## Data validity

- **Demand.** 163,745 internal rides per average school-term weekday (July + August 2026).
  - July and August agree within 0.1 % per weekday (163,702 and 163,794).
  - September is 3.5 % lower (7.9 % lower at 07:00), consistent with its school-holiday week.
  - 66 % of rides touch a station stop, and the hourly profile has the expected peaks.
- **Bus option.** 0.4 % of rides have no direct service in LTA's route data and are excluded
  from both sides of every comparison.
  - The 05:00 hour was previously 63 % uncovered because uniform-in-hour times put riders
    before the first bus. Times are now drawn within the served part of the hour, leaving
    2 % uncovered.
- **Destinations.** LTA's description of the OD dataset is "number of trips … from the origin
  to destination bus stops". Bus fares are distance-based, so riders tap in and out. LTA does
  not document how journeys without a tap-out are handled.
- **Stops.** All 180 study stops snap to a drivable edge, median 7 m away. Three snap
  30–51 m away (the interchange driveway and two stops on Yishun Ring Road).
- **Census age.** The nine subzone rows sum to the planning-area total.

## Network validity

- **Routed vs published distances.** Across 268 consecutive stop pairs on LTA bus routes,
  routed distance divided by LTA's published distance has a median of 1.02 and an IQR of
  0.95–1.09.
  - 11 pairs (4 %) are off by more than 50 %. Some are LTA's 0.1 km rounding on short
    segments; some are snapping or topology errors.
  - Segments off by more than 40 % are excluded from calibration (211 of 1,508 sequences).
- **Routing tables.** Stop→stop times and distances from the routing tables equal an
  independent networkx computation (max |ΔT| = 0 s, max |ΔD| = 0 m).
- **Shuttle-km inside the boundary.** In a morning-peak sample, 98.5 % of shuttle-km fall
  inside the planning area, so the comparison with in-area bus-km is like for like.

## Model validity

- **Calibration fit (LTA estimates).** 171,838 matched observations on 1,297 stop sequences:
  in-sample r = 0.96, mean absolute error 36 s (17 %).
- **Held-out services (pass).** Refitting with whole services held out (5-fold): 17.9 % error,
  against 30.1 % for a distance-only model fitted the same way. The model's structure carries
  real information beyond distance.
- **Other hours (pass).** The fit, scored without refitting on 13:00–14:59 data
  (137,868 observations): observed/predicted = 1.00.
- **Observed GPS movement (pass).** Chained positions of the same bus, about 5 minutes apart.
  - Observed/modelled time (pooled) is 0.99 at 10:00–12:59 and 1.00 at 13:00–14:59, with
    route-level bootstrap intervals of about ±5 %.
  - A second design, with pairs chosen by distance rather than time, agrees.
  - The positions come from the same feed and day as the fitting data, but they are observed
    positions, not LTA's predictions.
  - Per-pair medians from the time-based design (about 1.06–1.11) are not used: with time
    fixed, slow buses cover less distance, which skews per-pair ratios upwards. Pooled
    ratios and the distance design do not have this problem.
- **Evening peak (unresolved).** At 17:30–19:30 the measures disagree.
  - LTA's estimates imply buses 10 % slower than the midday model (×1.10).
  - Chained GPS positions show ×1.02 (95 % interval 0.98–1.07; 1,191 pairs); the distance
    design gives ×1.00.
  - Speed bands on bus-route links show ×1.035.
  - An early read on the first half hour of evening data suggested a larger slowdown; it was
    too small to rely on, and the full two hours did not confirm it.
  - A sensitivity case applies the evening-peak calibration all day.
- **Cruise vs dwell (weakness found and bounded).** The LTA-estimate data cannot separate road
  time from stop dwell: across service-bootstrap draws they correlate at −0.95.
  - The GPS fit measures dwell directly: about 40 s (35–44 s), consistent with the
    estimate-based 40.6 s.
  - Its road-speed values are biased fast (robust loss; mean bus times underpredicted by
    about a quarter), so they are not used as a calibration.
  - Speed sensitivity uses only jointly fitted draws consistent with that dwell (road time
    −8 % to +10 %).
- **Estimator check.** On data generated from the model's own form, the estimator recovers the
  known parameters within 12 %, inside every bootstrap interval. This is a software test,
  not validation (`tests/test_models.py`).
- **Bus baseline.**
  - κ = 0.568 from GPS-monitored headways (0.556 if unmonitored predictions are included).
  - Observed mean headways agree with LTA's published bands.
  - Modelled feeder loop times are 1.0–1.3× LTA's scheduled first/last-bus offsets.
- **Realised bus waits.** The wait draws reproduce the expected wait exactly in the mean, and
  give exponential waits when κ = 1 (`tests/test_models.py`).

## Engineering validity

- **Insertion kernel vs brute force.** The numba kernel equals an explicit enumeration of every
  insertion on 400 random schedules: same optimal cost, and the chosen insertion is feasible
  with exactly the reported times.
- **Simulator.**
  - Exact times on a grid network.
  - Capacity-1 riders are serialised; same-destination riders pool.
  - Capacity is never exceeded.
  - Legs are sequential and continuous.
  - Kilometres add up by hour.
  - Repositioning legs carry nobody.
  - Berth limits hold, including when a rider joins a dwelling shuttle (a bug found by the
    engineering review and fixed).
  - Same seed gives the same result.
  - Randomized fleets, capacities and demand, with and without repositioning and kerb limits,
    pass all of these (`tests/test_sim.py`).
- **Bisection monotonicity.** Every fleet evaluated in the hour-window search is stored
  (`evaluated.json`); the export counts violations of the monotonicity the bisection assumes:
  126 checked, none found.
- **Runtime.** A full weekday (about 164,000 requests) simulates in 35–55 s on one CPU core.

## Reproducibility

- **Commands.** `make data`, then `make reproduce-core-results`, rebuilds experiments,
  sensitivity and page data from raw inputs and the committed calibration.
- **Seeds.** Every simulated day is seeded.
- **Provenance.** Each output records the calibration values, demand months, model cache key
  and git revision it came from.
- **Not reproducible later.** Live LTA data (bus arrivals, speed bands) cannot be
  re-downloaded for 15 Oct 2026, and DataMall serves fare-card months for only three months.
  - The calibration, GPS check and Yishun OD table are therefore committed in
    `data/processed/`.

## Red-team findings and what was done

| Finding (reviewer) | Action |
|---|---|
| Bus mean and shuttle mean covered different riders (engineering, science) | Fixed: both sides use rides with a bus option; the excluded share (0.4 %) is reported |
| 63 % of 05:xx rides had no bus option (engineering) | Root cause was uniform-in-hour times before the first bus; fixed by service-window sampling |
| Hourly fleets presented as if from fixed-fleet days (science) | Relabelled as lower bounds; the headline is the all-day fixed fleet, with the failing fleet below it |
| Shuttle stop time documented as 25 s, simulated as 20 s (all three) | Docs and labels corrected to 20 s; sensitivity at 15 s and 40 s |
| Sensitivity only ever improved the bus (science) | Added worse-bus cases (higher dwell, less regular, bunched) and a direction column |
| Speed sensitivity at marginal intervals ignored the cruise–dwell trade-off (found while fixing) | Jointly fitted draws, constrained by the GPS-measured dwell |
| Calibration on LTA estimates, in-sample, with optimistic intervals (science, expert) | Service-cluster bootstrap, service hold-out against a distance baseline, other-hour scoring, GPS check on observed movement |
| Peak hours uncalibrated (science, expert) | Evening peak collected and calibrated; sensitivity case; the morning peak is still unobserved (stated) |
| "Yes" stated without its conditions; "8 % slower" from one half hour of GPS; GPS check called independent; threshold prose ("cannot clear for hours") not matching the curves; unsourced kerb and block-age claims; vehicle-hours not like for like (second review) | Answer now conditional with the size and sensitivity ranges; evening peak reported from both measures over the full window; GPS check described as the same feed, different quantity; threshold text quotes the 08:00 hour by fleet; unsourced claims removed or sourced (HDB property data: 61 % of blocks from the 1980s); driving hours compared for both modes |
| September includes the school holidays (expert) | Base changed to July + August; September is a sensitivity case |
| "Share faster" compared realised shuttle with expected bus (science) | One simulated bus wait per ride; both measures reported; p90 for both modes |
| Vehicles and km compared across units and service sets (science) | Buses of all services inside Yishun, seats/places, in-area shuttle-km share |
| "Dozens of riders per km", "10 m of kerb", "door-to-door", "residents" (science) | Computed bus load lower bound replaces "dozens"; unsourced kerb length removed; wording fixed |
| Clean-checkout `make reproduce-core-results` failed without live logs (engineering) | Target no longer refits; committed calibration is used; `make live` reports collector failures |
| Explorer broke on missing keys or a failed scenario fetch (engineering) | Numbers computed once in the pipeline; charts and tables isolated; controls work without a scenario |
| Berth limit exceeded after a rider joined a dwell (engineering) | Fixed and tested |
| Refused riders drawn as waiting all night in the animation (engineering) | Fixed |
| Repositioning untested (engineering) | Randomized invariant tests with repositioning |
| Gap claim ignored Mo et al. 2021 (expert) | Added and the claim narrowed |
| Equity view computed but not shown (science, expert) | Shown as a subzone table with the ecological caveat and a rank correlation |
| Dispatcher not benchmarked against batch optimisation (expert) | Partly: wider candidate searches (two and four times as many vehicles per request) quantify how much the heuristic's search limit costs; a batch optimiser is the next step |
| Traffic-flow coverage misstated in `data.md`; GPS-fit bias figures not traceable to a committed file; one sensitivity label quoting a superseded dwell interval; "the sensitivity table applies" the evening-peak calibration (one case does); assumptions favouring the shuttles listed incompletely; hourly-resized vehicle-hours stated without "at least"; chart labels colliding at phone width (launch audit: numbers audits of docs and page, a skeptical read, screenshot checks) | Coverage recounted from the raw file (13 links in the planning area, no estate roads); bias restated from `gps_pairs_sample.csv`; the case re-run (same draw, model key and result; label regenerated); wording fixed; phone layouts fixed and re-checked |

## Known weaknesses

- **Morning peak not observed.** The fleet threshold is set in the 07:00–09:00 rush. The
  evening-peak calibration is a stand-in.
- **Calibration source.** The fit uses LTA's estimates. Observed GPS movement agrees within
  about 5 % at midday, but that is one day.
- **Bus crowding.** Denied boarding is not modelled, which favours the bus at peaks.
- **No traffic feedback.** Hundreds of shuttles do not congest roads in the model.
- **Dispatcher.** Immediate insertion with exact travel times; neither a batch optimiser nor
  realistic travel-time noise.
  - The fleet depends on it: searching two or four times as many vehicles per request lowers
    the threshold from 450 to 400 or 375. A batch optimiser could lower it further.
  - 450 is what this simple dispatcher needs, not a floor.
- **Stages, not trips.** Two-bus trips inside Yishun stay two requests.
