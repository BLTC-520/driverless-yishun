# Methodology

This document describes how each number on the page is produced. Code references point to
`pipeline/yishun/`. Status labels follow the decision record: **observed** (data),
**calibrated** (fitted to data), **modelled**, **simulated**, **assumed**.

## 1. Study area and demand (`study_area.py`, `demand.py`)

- **Study area.** The URA Master Plan 2019 *Yishun* planning area (21.0 km²). It contains
  180 LTA bus stops.
- **Demand (observed)** is LTA DataMall *Passenger Volume by Origin Destination Bus Stops*.
  For each calendar month it gives the number of fare-card rides by day type and hour of
  tap-in. Each ride has a tap-in stop and a tap-out stop.
  - We keep weekday rides whose origin **and** destination lie in the study area. Same-stop
    tap-in/tap-out pairs are dropped.
  - **Base months: July and August 2026**, both full school-term months: 43 weekdays, after
    excluding the National Day holiday on Monday 10 August. Monthly totals are summed and
    divided by 43.
  - The result is 163,745 rides on an average school-term weekday: 4,861 stop pairs in
    59,880 (pair, hour) cells.
  - **September 2026** contains the one-week school holiday and Teachers' Day. It has 3.5 %
    fewer internal rides per weekday and 7.9 % fewer at 07:00. It is kept as a sensitivity
    case.
  - The filtered table is committed (`data/processed/internal_od_202607_202608.csv.gz`).
    DataMall serves only the last three months, so this keeps runs reproducible later.
  - Each record is a bus *ride* (a journey stage). A trip with a transfer inside Yishun
    appears as two rides, and the two are not merged in the simulation.
  - Riders may live anywhere. What is counted is where they board and alight.
- **Daily replicates (simulated).** A simulated day draws a Poisson number of requests for
  each (origin, destination, hour) cell, with mean equal to the observed average.
  - Request times are uniform within the hour, because the data has hourly resolution.
    Every recorded rider boarded a running bus, so times are drawn only within the part of
    the hour in which a line serving that pair runs at the origin, by LTA first/last bus
    times and published time bands. This matters at the start and end of service. Without
    it, 63 % of 05:xx rides would fall before the first bus.
  - Rides tapped in before 04:00 (in practice 00:xx and 01:xx) belong to the end of the
    service day and are shifted by +24 h.
- **Day-to-day variation is not observed.** The data are monthly totals. Poisson replicates
  capture only randomness within a day around the monthly average. Larger swings are covered
  by the September case and the ±20 % demand cases.

## 2. Road network (`network.py`, `routing.py`)

- **Network.** OpenStreetMap drivable roads inside a bounding box of the planning area plus
  about 1 km. Bus-only roads (the interchange driveway) are allowed for public-transport
  vehicles. The largest strongly connected component is kept: 5,198 nodes, 8,542 directed
  edges.
- **Stop placement.** Each bus stop is snapped to the directed edge on whose **left** it lies.
  Singapore drives on the left, so a vehicle serving the stop is travelling the right way.
  Median snap distance is 7 m.
- **Network check.** Routed distances between consecutive stops on real bus routes match
  LTA's published route distances: median ratio 1.02, interquartile range 0.95–1.09,
  268 pairs. Segments that disagree by more than 40 % are excluded from calibration.
- **Edge travel time:** `free-flow time × m + n_sig × s_sig`.
  - The free-flow time uses class speeds (primary 50 km/h, residential 30 km/h, and so on).
  - `m` is a calibrated cruise multiplier shared by all road classes.
  - `n_sig` counts signal-controlled locations met on the edge. OSM signal nodes are merged
    into 157 locations by 30 m single-linkage clustering; a location counts if it lies within
    25 m of the edge's downstream half.
  - `s_sig` is a calibrated delay per signal-controlled location.
- **Routing tables.** One reverse Dijkstra per stop gives node→stop times and next hops.
  Stop→stop times match an independent networkx computation exactly. Both modes use the same
  network and the same speeds.

## 3. Calibration (`collect_live.py`, `calibrate.py`, `gps_check.py`)

- **Collection (observed).** LTA's `v3/BusArrival` returns, for each service at a stop, the
  next three buses. Each comes with an estimated arrival time and, when GPS-monitored, the
  bus's current position, load band and deck type.
  - We polled the 151 stops coded 59xxx (most of the 180 study stops) every 90 s on Thursday
    15 October 2026: 10:06–14:57 and 17:30–19:30 SGT.
- **Observations for the fit.** In one polling cycle, the same GPS-monitored bus appears at
  stops A and B of its route. It is matched by service, by its reported position and by the
  order of the ETAs.
  - The difference of the two ETAs is LTA's current estimate of the running time A→B. It
    includes the dwell at A and at every intermediate stop.
  - We use pairs one to six stops apart from 10:00–12:59: 171,838 matched observations on
    1,297 stop sequences of 24 services.
  - These are LTA's real-time **estimates**, not observed passage times. The GPS check below
    uses observed positions instead.
- **Model.** Weighted least squares on sequence medians (weights √n):
  `run = m·t_ff + s_sig·n_sig + dwell·stops + hub_extra·station_stops`.
  - Fit: m = 0.88, s_sig = 15.1 s, dwell = 40.6 s, hub_extra = 25.3 s.
  - **Uncertainty.** Bootstrap over bus services. Overlapping sequences of one service are not
    independent, so whole services are resampled. Every draw is kept in
    `data/processed/calibration.json`.
  - The data pin down total running time well, but not its split between cruise and stops.
    Longer sequences have both more distance and more stops, so across draws m and dwell
    correlate at −0.95. The marginal intervals are therefore wide (m 0.30–1.64). The jointly
    fitted sets are not.
- **Predictive checks (no refit).**
  - **Hold out whole services** (5-fold): mean absolute percentage error 17.9 %, against
    30.1 % for a distance-only model fitted the same way. In-sample it is 16.7 %
    (r = 0.96).
  - **Other hours.** The 10:00–12:59 fit scored on 13:00–14:59 data (137,868 observations):
    observed/predicted = 1.00, bias +0.2 s per sequence. On 17:00–19:59 data it is 1.07:
    buses are about 6.5 % slower in the evening peak.
- **GPS check (observed movement, `gps_check.py`).**
  - Each distinct reported position of a bus on a route pattern is a fix, timed at the first
    poll that reports it.
  - The fix is placed on the route's network path within the 2.5 km before the next stop
    the bus is reported heading to. Fixes more than 40 m off the path are rejected.
  - Fixes of the same bus are chained across polling cycles.
  - For pairs of fixes 5–20 minutes apart, observed elapsed time is compared with the
    model's running time between the two positions (road times plus dwell at the stops in
    between).
  - Result: observed/modelled = 0.99 at 10:00–12:59 and 1.00 at 13:00–14:59 (95 % interval
    over routes about ±5 %), and 1.07 in the evening peak.
  - **GPS fit.** Fitting the same four parameters on short pairs of fixes (robust loss)
    gives dwell = 39.7 s (95 % interval 35.6–44.5 s), confirming the ETA-based dwell. Short
    pairs that pass no stop show pure road time, which is what separates dwell from cruise.
    It also gives m = 0.71 and s_sig = 8 s: somewhat faster roads, within the intervals.
  - Fix times carry tens of seconds of noise, so single pairs are noisy; the summaries pool
    hundreds of pairs.
- **Headway regularity.** For random rider arrivals the mean wait is `E[H²]/(2E[H])`,
  written κ·E[H]. κ is estimated from the gaps between successive predicted arrivals of the
  same service at the same stop.
  - Only gaps between two GPS-monitored buses are used; unmonitored predictions follow the
    timetable.
  - Result: κ = 0.568 (median over service–stop pairs, IQR 0.54–0.61); 0.556 without the
    monitored filter. A perfectly regular service has κ = 0.5; exponential headways give
    κ = 1.
- **Evening peak.** Collection ran 17:30–19:30 SGT. `calibration_pm_peak.json` refits the
  model on those hours. A sensitivity case applies it all day.
- **Not covered.** The morning peak (07:00–09:00), which sets the headline fleet, was not
  observed. The evening-peak case is the stand-in.

## 4. Today's bus network (`busnet.py`, `supply.py`)

- **Common-lines model** (Chriqui & Robillard 1975). For each ride (origin stop i,
  destination stop j, minute t) the attractive lines are the services that visit i and
  later j on the same run and are operating at t (LTA first and last bus per stop). Lines
  are added in order of in-vehicle time while they lower the expected total.
  - `E[wait] = κ / Σ f_l`, with frequencies from LTA's published headway range for the time
    band (midpoint). Before 06:30 no band is published, so the late-evening band is used.
  - `E[in-vehicle] = Σ f_l·ivt_l / Σ f_l`.
  - In-vehicle time is the sum of calibrated network running times between consecutive stops
    of the route. It adds the calibrated dwell at the boarding stop and every intermediate
    stop, plus the extra at stations.
- **Realised waits (for tails and ride-by-ride comparisons).** Each simulated ride also gets
  one random bus wait. Headways are gamma-distributed with CV² = 2κ − 1, the CV that
  reproduces κ. A rider arriving at random lands in a length-biased headway and waits a
  uniform fraction of it, so the mean of the draws equals the expected wait. In-vehicle time
  is kept at its expected value.
- **No option.** 0.4 % of rides have no direct service between their two stops in LTA's
  route data (route variants, loops). They are excluded from **both** sides of every
  comparison.
- **Validation.**
  - Observed headways from the live feed match the published bands (for example service 811:
    4.5 min observed against 4–6 min published).
  - Modelled feeder loop times are 1.0–1.3× LTA's scheduled first/last-bus offsets, as
    expected for daytime loads.
- **Supply (modelled from published headways, not operator logs).**
  - **Bus-km inside Yishun:** route distances between consecutive in-area stops × trips.
  - **Buses inside Yishun (all services):** modelled running time on in-area segments ×
    trips per hour.
  - **Feeder buses on the road:** modelled loop time plus a 5-minute layover, divided by the
    headway.
  - **Places per bus:** the mix of single-deck, double-deck and bendy buses observed in the
    live feed at Yishun stops. These are weighted by about 90, 125 and 120 riders, seated
    and standing. The capacities are from secondary sources and are approximate.
- **Not modelled.** Crowding and denied boarding. This makes the bus look better at the
  peaks.

## 5. Shuttle simulator (`sim.py`, `insertion.py`)

- **Event-driven.** Request arrivals, vehicle arrivals and departures at stops, and
  repositioning ticks.
- **Vehicles** carry 4, 10 or 20 riders and stop only where riders board or alight.
  - Each stop takes **20 s** plus 4 s per rider boarding or alighting (assumed). Buses carry
    a calibrated 40.6 s per stop served, plus 25 s at stations, because they stop where
    anyone boards; shuttles pay per rider.
  - Vehicles can be re-routed at any road-network node.
- **Dispatch.** Each request is assigned immediately to the cheapest feasible insertion
  (pickup position i, dropoff position j). Candidates are the 24 vehicles that can reach the
  rider soonest and the 8 whose schedules end soonest.
  - Feasibility: capacity; the new rider's in-vehicle time stays within 1.6 × direct + 4 min;
    no rider already assigned is pushed more than 5 min past their promised time.
  - Cost: the new rider's wait plus ride, plus the delay imposed on riders already assigned,
    plus 0.1 × the extra vehicle time.
  - The dispatcher knows travel times exactly. Real operations would see variation, which
    widens tails.
  - The numba kernel is checked against a brute-force enumeration on 400 random cases
    (`tests/test_insertion.py`).
- **Repositioning.** Every 60 s, idle vehicles move towards stops whose expected pickups
  over the next 15 minutes exceed the idle vehicles nearby. Expected pickups are the observed
  average-weekday rates: the operator knows typical demand, not the actual requests.
- **Refusals.** A rider is refused when the best insertion picks them up more than
  45 minutes after the request. A rider is also refused when the chosen vehicle's schedule
  has reached the simulator's limit of 96 stops. Both happen only in fleets far below the
  threshold, and the reason is recorded.
- **Kerb test.** A station's stops share a number of berths. A shuttle that finds them all
  in use waits until one frees. The dispatcher does not anticipate these queues, so pickups
  at a limited kerb can slip past the 5-minute promise.
- **Checked invariants** (`tests/test_sim.py`):
  - exact times on a hand-computable grid;
  - capacity never exceeded;
  - every vehicle's legs are sequential and continuous;
  - kilometres add up by hour;
  - repositioning legs carry nobody;
  - berth limits hold, including when a rider joins a dwelling shuttle;
  - same seed gives the same result.
  - These hold over randomized fleets, capacities and demand, with and without
    repositioning and kerb limits.

## 6. Experiments and the parity rule (`experiments.py`, `sensitivity.py`, `export_results.py`)

- **Comparison.** Stop to stop, waiting plus riding, for the same rides at the same minute,
  by bus (model) and by shuttle (simulation).
  - Walking to the stop is the same in both modes, so it is left out.
  - Rides with no bus option are excluded from both modes.
- **Keeps up in an hour:** no refused riders, and the mean shuttle time of rides requested in
  that hour is no worse than the bus model's expected time for the same rides.
- **Fixed-fleet days.**
  - Grid: fleet size × capacity (4, 10, 20) × 3 demand replicates. Steps are 25 vehicles
    near the threshold for 10-seat shuttles.
  - **All-day parity fleet:** the smallest simulated fleet that keeps up in every hour of
    every replicate, with every larger simulated fleet also keeping up. We report it with
    the largest simulated fleet below it, which fails. The threshold lies between the two.
  - **p90 rule:** the same with the 90th-percentile time against the 90th percentile of
    realised bus times (one wait draw per ride), a stricter, tail-based standard.
  - Curves average the served riders. For fleets that refuse riders, a lower bound counts
    each refused rider at 45 minutes plus a direct ride.
- **Hour-window requirement.** Each hour is simulated with 45 minutes of real demand before
  it and 15 minutes after.
  - The fleet starts spread over stops in proportion to that hour's demand, with no backlog
    from earlier hours.
  - We bisect for the smallest fleet that keeps up and report the larger of two replicates.
    Every evaluated fleet is stored, so the bisection's monotonicity assumption is checked.
  - This is a **lower bound**: the fleet an operator would need if vehicles could enter and
    leave service every hour. The all-day fixed fleet is larger because the morning backlog
    carries over.
- **Kerb.** For every station's stops, the number of shuttles stopped at the same moment is
  sampled once a minute. Idle vehicles waiting for work are counted separately. The kerb
  experiment repeats the parity fleet (and +50) with 30, 20, 14, 10 and 7 berths per
  station.
- **Sensitivity.** The all-day parity fleet is recomputed under alternative assumptions, on
  the same three replicates. Cases push in both directions:
  - **Road speeds:** calibration draws at the 2.5th and 97.5th percentile of road time,
    among draws whose bus dwell matches the GPS-measured dwell. Also the GPS-based fit and
    the evening-peak calibration.
  - **Better bus:** lower dwell, more regular buses, riders timing their arrival with apps.
  - **Worse bus:** higher dwell, less regular buses, bunched peak-style headways
    (κ = 0.75).
  - **Shuttle:** stop time 15 s or 40 s, no repositioning, looser pooling.
  - **Demand:** September 2026, and ±20 %.
- **Provenance.** Every output records the calibration values, demand months, model cache
  key and git revision it was computed from (`config.json`, `evaluated.json`,
  `sensitivity.json`).
