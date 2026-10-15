# Methodology

This document describes how each number on the page is produced. Code references point to
`pipeline/yishun/`.

## 1. Study area and demand (`study_area.py`, `demand.py`)

- **Study area.** The URA Master Plan 2019 *Yishun* planning area (21.0 km²). It contains
  180 LTA bus stops.
- **Demand** is LTA DataMall *Passenger Volume by Origin Destination Bus Stops* for September
  2026. For each calendar month this dataset gives the number of fare-card rides (tap-in at
  the origin stop, tap-out at the destination stop) by day type and hour of tap-in.
  - We keep weekday rides whose origin **and** destination lie in the study area. Same-stop
    tap-in/tap-out pairs are dropped.
  - Monthly totals are divided by 22, the number of weekdays in September 2026 (no public
    holidays fell on weekdays that month).
  - The result is about 158,000 rides on an average weekday, in about 54,000 stop pairs.
  - These are bus *rides* (journey stages). A trip with a transfer appears as two rides.
- **Daily replicates.** A simulated day draws a Poisson number of requests for each
  (origin, destination, hour) with mean equal to the observed average. Request times are
  uniform within the hour, because the data has hourly resolution. Rides tapped in after
  midnight (hours 00 and 01) belong to the end of the service day; they are shifted by +24 h.
- **Caveat.** September 2026 includes the one-week school holiday, so this is an average
  weekday of that month, not a term-time weekday.

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
  - `m` is a calibrated multiplier.
  - `n_sig` counts signal-controlled locations met on the edge. OSM signal nodes are merged
    into 157 locations by 30 m single-linkage clustering; a location counts if it lies within
    25 m of the edge's downstream half.
  - `s_sig` is a calibrated delay per signal-controlled location.
- **Routing tables.** One reverse Dijkstra per stop gives node→stop times and next hops.
  Stop→stop times match an independent networkx computation exactly. Both modes use the same
  network and the same speeds.

## 3. Calibration on live bus data (`collect_live.py`, `calibrate.py`)

- **Collection.** LTA's `v3/BusArrival` returns, for each service at a stop, the next three
  buses with estimated arrival time and the bus's current GPS position. We polled all 180
  Yishun stops every 90 s.
- **Observations.** In one polling cycle the same GPS-monitored bus appears at stops A and B
  of its route (matched by service, position within 30 m and order of ETAs). The difference
  of the two ETAs is LTA's current estimate of the running time A→B, including the dwell at
  A and every intermediate stop. We use pairs one to six stops apart: about 250,000 matched
  observations on about 1,300 stop sequences.
  - These are LTA's real-time **estimates**, not observed passage times.
- **Model.** Weighted least squares on sequence medians:
  `run = m·t_ff + s_sig·n_sig + dwell·stops + hub_extra·station_stops`.
  The 95 % intervals come from bootstrapping over sequences. Fitted values are in
  `data/processed/calibration.json`.
- **Headway regularity.** For random rider arrivals the mean wait is `E[H²]/(2E[H])`, which
  we write as κ·E[H]. We estimate κ from the gaps between successive predicted arrivals of the
  same service at the same stop: median 0.557 over 532 service–stop pairs, IQR 0.53–0.60.
  A perfectly regular service has κ = 0.5; exponential headways give κ = 1.
- **Limitation.** The calibration data covers late morning (10:00–13:00). Peak-hour
  congestion is not observed, so peak running times are probably optimistic for **both**
  modes.

## 4. Today's bus network (`busnet.py`, `supply.py`)

- **Common-lines model** (Chriqui & Robillard 1975). For each ride (origin stop i,
  destination stop j, minute t) the attractive lines are the services that visit i and later
  j on the same run and are operating at t (LTA first and last bus per stop). Lines are added
  in order of in-vehicle time while they lower the expected total.
  - `E[wait] = κ / Σ f_l`, with frequencies from LTA's published headway range for the time
    band (midpoint).
  - `E[in-vehicle] = Σ f_l·ivt_l / Σ f_l`.
  - In-vehicle time is the sum of calibrated network running times between consecutive stops
    of the route, plus the calibrated dwell at the boarding stop and every intermediate stop.
- **Validation.**
  - Observed headways from the live feed match the published bands (for example service 811:
    4.5 min observed against 4–6 min published).
  - Modelled feeder loop times are 1.0–1.3× LTA's scheduled first/last-bus offsets, as
    expected for daytime loads.
- **Supply.** Bus-km inside Yishun and feeder buses on the road come from published headways,
  route distances between consecutive in-area stops, and modelled loop times plus a 5-minute
  layover. These are estimates, not operator logs.
- **Not modelled.** Crowding and denied boarding. This makes the bus look better at the
  peaks.

## 5. Shuttle simulator (`sim.py`, `insertion.py`)

- **Event-driven.** Request arrivals, vehicle arrivals and departures at stops, and
  repositioning ticks.
- **Vehicles** carry 4, 10 or 20 riders. They stop only where riders board or alight:
  25 s per stop visit plus 4 s per rider boarding or alighting. They can be re-routed at any
  road-network node.
- **Dispatch.** Each request is assigned immediately to the cheapest feasible insertion
  (pickup position i, dropoff position j) among the 24 vehicles that can reach it soonest
  and the 8 whose schedules end soonest.
  - Feasibility: capacity; the new rider's in-vehicle time stays within 1.6 × direct + 4 min;
    no rider already assigned is pushed more than 5 min past their promised time.
  - Cost: the new rider's wait plus ride, plus the delay imposed on riders already assigned,
    plus 0.1 × the extra vehicle time.
  - The numba kernel is checked against a brute-force enumeration on 382 random cases
    (`tests/test_insertion.py`).
- **Repositioning.** Every 60 s, idle vehicles move towards stops whose expected pickups
  over the next 15 minutes exceed the idle vehicles nearby. Expected pickups are the observed
  average-weekday rates: the operator knows typical demand, not the actual requests.
- **Refusals.** Every ride is served unless its best pickup is more than 45 minutes away;
  such riders are counted as refused. An undersized fleet therefore shows up as long waits and
  refusals, not as hidden queues.
- **Checked invariants** (`tests/test_sim.py`):
  - exact times on a hand-computable grid;
  - capacity never exceeded;
  - every vehicle's legs are sequential;
  - same seed gives the same result.

## 6. Experiments and the parity rule (`experiments.py`, `sensitivity.py`)

- **Comparison.** Stop to stop: waiting plus riding, for the same rides at the same minute,
  by bus (model) and by shuttle (simulation). Walking to the stop is the same in both, so it
  is left out.
- **Keeps up in an hour:** no refused riders, and the mean shuttle time of rides requested in
  that hour is no worse than the mean bus time for the same rides.
- **Fixed-fleet days.**
  - Grid: fleet size × capacity × 3 demand replicates.
  - *All-day parity fleet*: the smallest simulated fleet that keeps up in every hour.
- **Hour-window requirement.** Each hour is simulated with 45 minutes of real demand before
  it and 15 minutes after. The fleet starts spread over stops in proportion to that hour's
  demand. We bisect for the smallest fleet that keeps up. This is the fleet an operator could
  schedule hour by hour; the fixed-fleet day additionally has to absorb backlogs carried
  between hours. We report the larger of two replicates.
- **Kerb.** For every station's stops, the number of shuttles stopped at the same moment is
  sampled once a minute. Idle vehicles waiting for work are counted separately.
- **Sensitivity.** The all-day parity fleet is recomputed under alternative assumptions:
  - calibration interval bounds;
  - a better bus (lower wait factor, riders who time their arrival with live-arrival apps);
  - shuttle stop time;
  - demand ±20 %;
  - no repositioning;
  - looser pooling.
