# Driverless Yishun

**Could autonomous shuttles carry every bus ride inside a mature Singapore town, and what would that take?**

A simulation study of Yishun (221,610 residents, Census 2020). It replays every bus ride that starts and ends *inside* the town, using LTA fare-card counts for an average school-term weekday of July–August 2026 (about 164,000 rides). Those rides go through a fleet of pooled, on-demand autonomous shuttles and are compared, ride by ride, with today's bus network. The road model is calibrated to LTA's live bus data and checked against observed bus GPS movement.

![Yishun in the morning peak with 10-seat shuttles](docs/img/stage_desktop.png)

**Site:** [yishun.brianhar.site](https://yishun.brianhar.site) · the study, its [evidence page](https://yishun.brianhar.site/evidence.html) (every check, the review, data files, provenance) and a game on the same data.

| | Part 1 · capacity | Part 2 · cost |
|---|---|---|
| **Question** | Could shuttles carry every internal bus ride? | Can a bus and shuttle mix save riders' time at an acceptable cost? |
| **Answer** | Yes in the model: **450** ten-seat shuttles keep up with the bus in every hour (375–550 across 18 alternative assumptions). That is 3.0 times today's buses, driving 4.7 times the kilometres. | No option tested lowers operating cost. With an operator on board, shuttles for the rides the bus serves worst buy riders' time at **SGD 33–36 an hour**; that time is worth SGD 0.61–0.65 per SGD 1 spent. |
| **Read** | [Findings below](#findings) · [methodology](docs/methodology.md) · [validation](docs/validation.md) | [Phase 2 report](docs/phase2/report.md) · [tables](docs/phase2/results.md) · [independent review](docs/phase2/review.md) |

<!-- FINDINGS -->
## Findings

1. **The demand is short, hub-bound feeder riding.** 163,745 rides per average school-term weekday (July–August 2026) start and end inside Yishun. The median is 1.06 km in a straight line, and 66% start or end at an MRT station or the interchange. Today's buses deliver 11.8 min stop to stop on average (3.3 waiting + 8.5 riding).
2. **There is a sharp capacity threshold.** With 10-seat shuttles, 450 vehicles keep up with the bus in every hour of all three simulated weekdays (6.9 min at 08:00 against the bus's 10.4 min). With 425, the queue left by the 07:00 rush pushes the 08:00 hour to 12.2 min before it clears; with 375, to 39.1 min, and 1.1% of the day's riders are refused. Above the threshold the shuttle is 44 % faster stop to stop over the day (6.6 vs 11.8 min). Bigger vehicles help less than their seats suggest: 700 four-seat, 450 ten-seat or 375 twenty-seat vehicles, because at the threshold a shuttle carries 1.8 riders on average. Matching the bus's 90th-percentile time in every hour instead needs 450 ten-seat shuttles.
3. **It takes more vehicles than today's buses, and far more driving.** In the model, 450 shuttles is 3.0 times the 152 buses of all services inside Yishun at 07:00 (81 of them feeders). Each bus carries about ten times as many people (about 16,200 places against 4,500 shuttle seats). The fleet drives 159,924 km inside Yishun per weekday, 4.7 times the 33,871 km all buses drive there, carrying 1.8 riders on average against at least 8 per bus-km. Singapore's whole autonomous passenger fleet is 16 vehicles (MOT, Sep 2026).
4. **Feeder theory points the same way.** In a single feeder zone, demand-responsive service beats fixed routes only below about 10–50 riders per square mile per hour (Li & Quadrifoglio 2010). Averaged over the town, Yishun's internal demand at 07:00 is about 2,000 riders per square mile per hour. If the fleet in service could change every hour, the off-peak would need far fewer vehicles (about 200 at midday): at least 5,250 vehicle-hours in service a day instead of 9,450. The fixed fleet spends about 6,632 of its hours driving, against about 1,463 hours of bus driving inside Yishun.
5. **The MRT kerb becomes a bottleneck.** Up to 27 shuttles board or alight at once at the Yishun MRT and interchange stops, and 18 at Khatib, before idle vehicles waiting for work.
6. **Who gains.** With 450 ten-seat shuttles, pooled over 3 simulated weekdays, 92% of rides reach their stop sooner than by bus, comparing each ride with one simulated bus wait (94% beat the bus's average time for that trip). The average saving is 5.2 minutes. Longer rides gain more: 78% of all rides under 0.5 km are faster, against 97% of all rides over 1.5 km, where bus routes loop and stop more often than a direct shuttle. After 20:00, when buses run less often, 98% are faster; in the 07:00–09:00 peak, 78%. The slowest tenth of shuttle rides take more than 10.5 min, against 19.7 min by bus (12.9 against 17.3 min in the 07:00–09:00 peak). Of the rides that are slower by shuttle, 18% are under 0.5 km; in 94% the shuttle wait is longer than the bus wait, and in 18% the shuttle ride is longer than the bus ride.
7. **Kerb capacity is a hard constraint.** Limiting each station to 14 shuttles boarding at once still keeps up at 07:00 (9.3 min). At 10, kerb queues push the 07:00 hour to 41.4 min and the fleet no longer matches the bus. Adding vehicles makes it worse: 500 shuttles with the same kerb take 41.8 min, because the extra vehicles queue too.
8. **The dispatcher is a lever as big as the vehicle.** The simple dispatcher used here considers up to 32 shuttles per request. Considering twice or four times as many lowers the threshold from 450 to 400 or 375.
9. **Sensitivity.** Across 18 alternative assumptions, pushing both ways, the all-day 10-seat fleet ranges 375–550 (base 450). The largest moves: demand +20% (same pattern) (550); demand -20% (same pattern) (375); dispatcher searches four times as many vehicles per request (96 nearest + 32 soonest free) (375).

*Calibration: 171,838 matched LTA arrival estimates on 1,297 stop sequences (10:00–12:59). With whole services held out, error is 18 % against 30 % for distance alone. Observed bus GPS movement takes 0.99× the modelled time at midday and 1.02× in the evening peak, where LTA's estimates imply 1.10×. Fleets are the smallest simulated on a 25-vehicle grid; demand replicates are Poisson draws around the observed average weekday.*

## Why this question (and not the one in the brief)

The starting brief proposed a SUMO microsimulation of 0–80 % *private* autonomous cars, plus V2X roadside units, new signal strategies and parking conversion. Checking it against evidence changed the project. The full record is in [`docs/decision.md`](docs/decision.md).

- **Singapore's AVs are fleets serving towns.**
  - Car ownership is capped by the vehicle quota.
  - The national AV passenger fleet is "16 passenger vehicles, all in Punggol" (MOT, 18 Sep 2026). Punggol is about to trial point-to-point service "within the whole estate, without the need for fixed routes".
  - LTA stopped a planned autonomous-bus pilot on two public bus services in October 2026, to look at narrower uses first (reported by Mothership, confirmed by LTA).
- **The brief's mechanism would echo its own assumptions.**
  - Car-following AV models mostly reflect the headways you give them.
  - Singapore's signals already run on the adaptive GLIDE system.
  - Junction counts suitable for calibration are sparse one-day surveys (2017 – Jan 2024).
- **The data that does exist is better than the brief knew.** LTA's fare-card OD gives *observed* rides between every pair of stops by hour. Its live bus feed allows a real calibration of road speed, signal delay, bus dwell and headway regularity.

So the project asks: if the on-demand model Punggol is trialling had to serve all of Yishun's internal bus riders, how many vehicles, how much driving and how much kerb would it need? The closest Singapore study, Mo et al. (2021, *TR-C* 127), simulated shared AVs *competing* with buses for first-mile trips in Tampines. This one holds demand fixed at observed rides and asks what replacing every internal bus ride would take.

## Phase 2: cost and passenger time

**Can a combined bus and shuttle service save passenger time at an acceptable additional operating cost?**
Phase 2 compares today's buses (A), full shuttle replacement (B) and a combined service (C), on the same
simulated days and the same 163,069 rides, stop to stop. In C, shuttles carry the rides the timetable
serves worst: those whose expected bus time exceeds a direct drive by at least θ minutes, decided from
published routes and headways before the rider travels. All buses are kept. Full report:
[`docs/phase2/report.md`](docs/phase2/report.md); tables: [`docs/phase2/results.md`](docs/phase2/results.md).

1. **No option tested lowers operating cost.** Every configuration with acceptable service costs more
   than today's buses and saves passenger time.
2. **With someone on board, an hour of riders' time costs about SGD 33–43.** With a safety operator on
   board (the current pilot requirement), four C designs (θ 6–14 min, 40–275 shuttles) save
   1,609–10,111 passenger-hours a weekday, 5–32 % of today's 32,056. They add SGD 56,000–370,000 a day
   (central case; low to high roughly half to twice), or SGD 33–36 per passenger-hour saved. Full
   replacement with 450 shuttles saves 13,943 hours for SGD 600,000 a day (SGD 43 an hour) with every
   bus kept, or SGD 36–37 an hour if the services that carry only internal riders were withdrawn:
   level with C. Narrower targeting buys fewer hours at about the same price.
3. **Staffing controls the cost.** Remote supervision with nobody on board, not permitted today, would
   bring C to SGD 20–21 an hour, and full replacement lower still (SGD 17 with 700 four-seat
   vehicles, on a weakly evidenced price without COE). An attendant on board costs about as much as
   a safety operator.
4. **A budget choice, not a single answer.** As a separate social estimate, at SGD 19.7 per hour of
   in-vehicle time the time saved is worth SGD 0.61–0.66 per SGD 1 of added cost with someone on
   board, and SGD 1.01–1.11 with remote supervision only. Time savings are not revenue.
5. **Full replacement fails at the kerb; C does not.** With at most 10 or 7 shuttles boarding at once
   per station (test values), full replacement loses time against today's buses whether riders it
   cannot serve wait or take the bus; the C designs keep 78–100 % of their saving. Under fleet and
   speed stresses, full replacement holds up once declined riders can take the bus.
6. **The bus model matters most where C looks.** If modelled bus times on the rides C selects were
   20 % too high, its saving would fall by 37–42 %. Checking those rides' bus times is the first
   evidence needed. An independent review found one such error, on the figure-of-eight feeder 812;
   it is fixed and every simulation re-run ([`docs/phase2/review.md`](docs/phase2/review.md)).

*Costs: SGD per average weekday, 2026 prices, excluding GST, low, central and high cases from a register
of 247 source rows (`data/parameters/cost_register.csv`). Vehicle prices exclude COE and registration
taxes. Fleet reserves for charging and maintenance are estimates, not a charging simulation. No
congestion feedback.*

## How it works

```mermaid
flowchart LR
  A[LTA fare-card OD<br/>Jul-Aug 2026] --> D[Observed demand<br/>164k rides/weekday]
  B[OpenStreetMap roads] --> N[Road network<br/>stops snapped left-side]
  C[LTA live bus arrivals<br/>15 Oct 2026] --> K[Calibration<br/>speed, signals, dwell, regularity]
  C --> G[GPS check<br/>observed bus movement]
  N --> K
  K --> G
  E[LTA routes + headways] --> BUS[Bus model<br/>common lines]
  K --> BUS
  K --> SIM[Shuttle simulator<br/>event-driven, pooled, insertion]
  D --> SIM
  D --> BUS
  SIM --> X[Experiments<br/>fleet x size x replicates<br/>hour windows, kerb, sensitivity]
  BUS --> X
  X --> W[Web explorer + findings]
```

| | What | Status |
|---|---|---|
| Demand | Rides between pairs of the 180 Yishun stops (179 have internal rides), by hour, average school-term weekday (July + August 2026; September as a check); Poisson replicates | **Observed** (LTA DataMall `PV/ODBus`) |
| Roads | OSM drive network; stops snapped to the left-hand kerb; routed distances match LTA route distances (median ratio 1.02) | **Observed + checked** |
| Speeds | Cruise multiplier, delay per signal-controlled location, bus dwell per stop and at stations, fitted on 171,838 live arrival-estimate pairs (10:00–12:59); held-out services 18 % error vs 30 % for distance alone | **Calibrated** |
| Speed check | Chained GPS positions of the same bus (same feed, observed positions rather than LTA's estimates): observed/modelled time 0.99 at midday. Evening peak: 1.02 by GPS, against 1.10 by LTA's estimates. Dwell measured directly (40 s) | **Observed** |
| Bus | Common-lines model over LTA routes and published headways; wait factor κ = 0.57 from GPS-monitored headways; one simulated wait per ride for tails | **Modelled** |
| Shuttles | Event-driven simulation; immediate insertion dispatch (kernel verified against brute force); re-routing at any node; demand-led repositioning | **Simulated** |
| Not modelled | Demand change, fares, congestion feedback, charging, safety operators, bus crowding, the morning-peak road speeds | **Assumed away** (see limitations) |

Details: [`docs/methodology.md`](docs/methodology.md) · Validation: [`docs/validation.md`](docs/validation.md) · Data and licences: [`docs/data.md`](docs/data.md)

## Reproduce

Python 3.12. An [LTA DataMall](https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html) key goes in `LTA_DATAMALL_KEY`. Registration is free.

```bash
make setup                    # uv venv + pinned requirements
make data                     # LTA DataMall, data.gov.sg, OpenStreetMap
make reproduce-core-results   # experiments -> sensitivity -> page data -> tests
make web && make serve        # http://localhost:8000 (landing page; the study is /study.html, the game /play.html)
# Phase 2 (cost and passenger time):
make phase2-experiments       # options A, B, C: 510 simulated days (about 1.5 h on 4 cores)
make phase2-results           # costs, comparison, thresholds -> summary.json, page data, charts, results tables
# optional, at the hours you want to calibrate on:
make live calibrate gps-check calibrate-peak
```

On 4 cores, the experiments and sensitivity take about two and a half hours. The live logs of 15 Oct 2026 cannot be re-downloaded, and DataMall serves fare-card months for only three months. The derived inputs are therefore committed in `data/processed/`: the Yishun OD table, `calibration.json`, `calibration_pm_peak.json` and `gps_check.json`. Every result file records the calibration, demand months and git revision it came from. Phase 2's grids and summary are committed in `data/processed/phase2/`, each with its commit, input digests and model key; `make phase2-allocation` needs the July and August 2026 full OD files.

```
pipeline/yishun/   fetchers, network, routing, calibration, bus model, simulator, experiments, exporters
tests/             insertion kernel vs brute force, simulator exact times and randomized invariants,
                   kerb queues, common lines, estimator check, demand sampling, bus wait draws,
                   real-network consistency
web/               landing page, static explorer (deck.gl + d3), Part 2 and evidence charts (Apache ECharts, see docs/echarts.md),
                   the game (WebGPU, physics.js + tests), build, screenshot and loop-recording scripts
tools/blender/     vehicle models for the explorer, generated in Blender
docs/              decision record, methodology, validation, data registry, how the charts are built (echarts.md)
data/processed/    calibration and experiment outputs (raw data is never committed)
```

## The site

The site at [yishun.brianhar.site](https://yishun.brianhar.site) has four pages, built by `web/build.py` from `web/src` and the page data in `web/public/data`:

- **Landing page**: both answers, and the ways in.
- **The study** (`study.html`): Part 1 and Part 2 as a scroll-driven story, with a 3D map of the simulated day to explore and ride along in.
- **Evidence** (`evidence.html`): the scorecard of every check, the independent review and what was done about it, the charts behind the checks, the data files and the provenance of every result.
- **Night Shift** (`play.html`): a driving game on the same data. Its vehicle models, renderer and physics are described in [`docs/nightshift.md`](docs/nightshift.md).

<!-- LIMITATIONS -->
## Limitations

- **Morning peak not observed.** The threshold is set in the 07:00–09:00 rush, but live data were
  collected 10:06–14:57 (with a gap from 12:02 to 12:33) and 17:30–19:30. In the evening peak, LTA's
  estimates imply buses about 10 % slower than the midday model, while chained GPS positions show
  almost no slowdown. One sensitivity case applies the evening-peak calibration all day as the
  cautious stand-in.
- **One day of live data.** The calibration and the GPS check come from Thursday 15 October 2026.
- **Demand held fixed.** Same riders, stops and times as today. Faster trips would attract riders,
  and a $4 fare (Punggol's announced fare) would deter some; neither is modelled. Rides are fare-card
  stages, so a two-bus trip inside Yishun stays two requests.
- **No congestion feedback.** Hundreds of shuttles do not slow each other or the buses. LTA's open
  traffic-volume data covers no estate roads in Yishun (only the Seletar Expressway and slip roads),
  so the added flow could not be compared with measured traffic. Kerb space is unlimited in the base
  case (a limit is tested separately).
- **Bus side.** Running times are calibrated to LTA's real-time *estimates*, checked against GPS
  movement. Crowding and denied boarding are not modelled, which flatters the bus at peaks. Waits
  assume riders arrive at random; riders using live-arrival apps wait less (tested in sensitivity).
- **Dispatcher.** Immediate insertion with exact travel times: neither a batch optimiser (which could
  need fewer vehicles) nor travel-time noise (which would widen tails).
- **Not modelled:** charging and depots, safety operators, breakdowns, fares, costs, emissions, and
  walking to stops (identical in both modes because both serve the same stops).

## Credits and licences

Contains information from LTA DataMall, HDB, URA and SingStat, accessed via LTA DataMall and data.gov.sg under the [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Code: see repository licence.

This is a simulation study. It is not a forecast of AV adoption, ridership, costs or safety, and it is not an LTA plan.
