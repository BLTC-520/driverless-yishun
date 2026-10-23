# Phase 2 shared definitions

*Fixed before implementation (22 Oct 2026). Every Phase 2 module, experiment, chart and text
uses these definitions. Changes are made here first and recorded in the change log at the end.*

Research question: **can a combined bus and autonomous shuttle service save passenger time at an
acceptable additional operating cost?**

## 1. Version and baseline

- Phase 1 is the state of `main` at commit `2f749d8` (results committed in `data/processed/`,
  computed at `a2ed35a`–`1abb678`; model key `198908c99fd0`). Phase 1 outputs were kept unchanged
  until the review's bus-model fix (change log, 23 Oct 2026); since then Phase 1's experiments are
  re-run on the Phase 2 graph and bus model, and both phases share one model.
- **Audit finding.** Phase 1 built the road graph by taking the *first* value of list-valued OSM
  tags after osmnx merged ways. That order follows Python's per-process string-hash seed, so each
  fresh build gave a different graph: 5,171–5,195 nodes on one extract. Phase 1's committed
  experiments are internally consistent, because all of them used one cached graph. They cannot be
  rebuilt exactly, because neither that graph nor its OSM extract (15 Oct 2026) was kept.
- **Phase 2 baseline.** The graph rule is now explicit and does not depend on the hash seed. An
  edge is drivable only when every merged part is drivable, and its speed class is the slowest
  part's (`network.keep_edge`, `network.road_class`). The OSM extract of 22 Oct 2026 is pinned in
  `data/processed/osm/` (ODbL). The result is 5,171 nodes, 8,482 edges, 158 signal sites and model
  key `213e91ad1ee8` (before the review's bus-model fix; `0cd6fcca7d4d` after it).
  - The bus model was unchanged at this point: hourly bus times identical to Phase 1 to 0.01 min.
  - Shuttle results move slightly. The Phase 1 grid is re-run on this graph
    (`data/processed/phase2/recheck_phase1/`).
  - **All three options are evaluated on this one graph, so no Phase 2 comparison mixes Phase 1
    numbers with Phase 2 numbers.**

## 2. Service options

| | Option | Definition | Bus service |
|---|---|---|---|
| **A** | Current bus | LTA routes and published headways; the Phase 1 common-lines model | As published |
| **B** | Full shuttle replacement (theoretical) | Every internal ride is a shuttle request (Phase 1 definition, fixed fleet all day) | Two bus-cost cases: (i) all buses retained; (ii) services that carry only internal riders are withdrawn (theoretical upper bound on bus savings, §6) |
| **C** | Combined bus + shuttle | Rides that the timetable serves worst are offered a shuttle (rule C-θ below); every other ride uses the bus as in A | All buses retained (default). Reductions only where evidence supports them (none in the default) |

**Rule C-θ ("timetable gap").**
- A ride from stop *o* to stop *d* requested at minute *t* is offered a shuttle when the bus is
  expected to be slow for it. The test is: the expected bus stop-to-stop time `E[wait] + E[in-vehicle]`
  exceeds the direct road time `T[o,d]` plus the shuttle's two stops (2 × (20 + 4) s = 48 s) by at
  least θ minutes.
  - `E[wait] + E[in-vehicle]` is the bus model's value at that minute, built from LTA's published
    routes, headway bands and first/last-bus times. It is the same value Option A uses.
- Every input is known before the passenger travels. Eligibility is a published table of stop
  pair × time of day. **The realised (simulated) bus wait is never used to choose the mode.**
- Purpose: put shuttles where the bus is slow, either because headways are long (early morning,
  evening) or because routes are indirect (loops), and keep them away from the 07:00 peak. There
  the bus is most frequent, and full replacement needs 450 vehicles.
  - Coarse analysis, seed 1 demand: rides with a gap above 8 min are 29 % of rides but hold 51 %
    of the gap.
  - Their busiest hour has about 4,100 rides, against 16,100 for full replacement at 07:00.
- θ sets coverage. The coarse search uses θ ∈ {4, 6, 8, 10, 12} min.

**Dispatch and declined requests (C).**
- Phase 1's dispatcher and simulator are used unchanged.
- A shuttle request whose best quoted pickup is more than `W_max` after the request is
  *declined*. The rider then takes the bus, at that ride's Option A time.
  - `W_max` = 15 min by default. Sensitivity: 45 min, the Phase 1 refusal limit.
- Each demand record is assigned once: bus-only, shuttle-served or shuttle-declined→bus. The
  three counts always add up to the ride count.

**Refused rides (B).** Phase 1 treatment. A request whose best pickup is more than 45 min away is
refused, and is counted at 45 min + its direct ride time, a lower bound.

**Refused-ride treatment sensitivity (all options).**
- R1 (default): C declined → bus time; B refused → 45 min + direct.
- R2: every refused or declined ride counted at 45 min + direct.
- R3: C declined → bus time + 5 min.

Refused and declined counts are always reported separately. An option never looks faster by
serving fewer people.

## 3. Boundaries

- **Area:** URA Master Plan 2019 Yishun planning area, its 180 bus stops (179 with internal rides).
- **Demand:** internal bus rides (fare-card stages with both ends inside Yishun), average
  school-term weekday, July + August 2026: 163,745 rides.
  - Each simulated day is a Poisson draw (seeds 1, 2, 3, …). **The same seeds are used for every
    option.**
- **Day:** one service day, 04:45 to the last drop-off after 01:00 (service hours 5–25).
- **Journey boundary: stop to stop.**
  - Time runs from arrival at the boarding stop (the request time) to alighting at the
    destination stop: waiting plus in-vehicle time.
  - Walking is excluded. All options serve the same stops with the same rides, and no option
    adds a bus-shuttle transfer, so walking is identical in all three.
  - Never call this door-to-door time.
- **Comparison set:** rides for which the bus model has an option. 0.4 % have none and are
  excluded from every option's time totals, as in Phase 1. They are reported separately.
- **Not in scope:** induced or shifted demand, fares and revenue, weekends and holidays,
  congestion feedback, bus crowding.

## 4. Passenger time metrics

| Metric | Definition |
|---|---|
| Wait | Request (arrival at the stop) → boarding. Bus: expected wait κ/Σf (means) and one simulated wait per ride (distributions). Shuttle: simulated |
| In-vehicle | Boarding → alighting. Bus: modelled expected in-vehicle time. Shuttle: simulated |
| Total (stop to stop) | Wait + in-vehicle |
| Passenger-hours | Sum of totals over all rides in the comparison set, including declined and refused rides at their treatment value |
| Time saved vs A | Passenger-hours(A) − passenger-hours(option), same rides, same seed |
| Mean, p90 | Per ride. Bus p90 uses the simulated waits, as in Phase 1 |

- **Aggregates use passenger-hours** (sums), never averages of subgroup means.
- **Bus means use expected bus times.** Their mean equals the mean of the simulated draws by
  construction; the draws are used only for p90 and for ride-by-ride gain/loss shares.
- **Time periods:** early 05–06, AM peak 07–08, off-peak 09–16, PM peak 17–19, evening 20–25
  (clock hours of the request).
- **Areas:** origin subzone; hub rides (one end at an MRT/interchange stop) and estate rides.
- **Passenger-km (all options):** the direct road-network distance between the two stops,
  identical across options. Vehicle-side on-board passenger-km is reported separately, as
  occupancy.

## 5. Cost units and conventions

- **Currency and price year: Singapore dollars (SGD), 2026 prices, excluding GST.**
  - Conversion: a foreign figure is converted to SGD at the annual average MAS exchange rate of
    its price year, then brought to 2026 with Singapore CPI (all items, SingStat).
  - Original figures, currency and year are always kept in the register.
- **Daily cost** = cost of one average weekday of service. Annual costs are allocated equally over
  **365 operating days** (the service runs every day; weekend demand is not modelled).
- **Capital annualisation:** equivalent annual cost = CRF(r, n) × (price − residual/(1+r)ⁿ),
  with CRF = r(1+r)ⁿ/((1+r)ⁿ − 1).
  - r is a real discount rate and n the useful life in years.
  - **A vehicle is either purchased (annuity) or leased (lease charge), never both.** A lease that
    bundles maintenance, insurance or software switches those categories off.
- **Bundled figures:** a contract value is used for a category only after its inclusions have been
  checked. A bundled contract is never treated as a vehicle price.
- **Precision:** results are rounded to the precision the inputs support (cost ratios to two
  significant figures). Ranges are always shown.

## 6. Bus costs and their allocation

- Bus supply inside Yishun comes from the Phase 1 supply model (published headways; not operator
  logs).
  - 33,871 bus-km and 2,439 bus-hours (running plus dwell) per weekday, over 54 services.
- **Who uses those bus-km** (observed demand, July + August 2026 full OD, frequency-weighted line
  choice; `phase2/bus_allocation.py`). Shares of in-area bus passenger-km:

  | Riders | Share |
  |---|---|
  | Internal riders (both ends in Yishun) | 53.4 % |
  | Riders with one end outside | 36.6 % |
  | Through riders (neither end in Yishun) | 9.9 % |

  - **Bus costs are therefore shared, and are never allocated wholly to internal riders.** The
    central allocation key is in-area passenger-km. The ride-count key is shown alongside.
- **Avoidable versus allocated.**
  - In A and C the bus network is identical, so **the bus cost cancels in every A–C comparison**:
    ΔCost(C − A) = shuttle cost.
  - The allocated bus cost is shown only as context (cost per ride under A).
  - In C, the bus cost allocated to internal riders is held at A's value, because the operator
    cannot avoid it.
- **Bus reductions.**
  - Fifteen services run entirely inside Yishun and carry only internal riders (100 % of their
    passenger-km): feeders 800, 801, 803, 804, 805, 806, 807, 807A, 807B, 807C, 811, 811A and 812,
    and trunk 461 and 117A (a short working). Together they run 15,246 bus-km/day (45 % of in-area
    bus-km), about 1,226 bus-hours and about 75 buses inside Yishun at 07:00
    (`phase2/bus_allocation.py`).
  - Only under B do all of their riders move. **Their withdrawal is B's theoretical upper bound on
    avoidable bus cost.**
  - Trunk services (2–76 % internal) are retained in every option.
  - In C, no service loses all of its riders, so no reduction is modelled.
  - Any frequency reduction would need load profiles and LTA service standards. Without them it is
    reported as not evaluated.

## 7. Shuttle cost model (`pipeline/yishun/costs.py`)

**Inputs from a simulated day** (`ShuttleOps`):
- capacity (seats);
- `fleet_in_service`: the simulated fixed fleet;
- service hours H;
- vehicle-km (loaded + empty);
- vehicles in service by hour (optional);
- rides served, passenger-km.

**Fleet terms.**

| Term | Definition |
|---|---|
| In service | The simulated fleet, available for dispatch through the service day |
| Charging reserve | Extra vehicles so that daytime charging does not take vehicles out of service |
| Maintenance reserve | Spare ratio × in service |
| Total fleet (owned or leased) | In service + charging reserve + maintenance reserve |
| Unavailable vehicle-hours | (Total − in service) × H |

**Availability estimate.**
- Labelled an estimate, not a charging simulation.
- Energy per in-service vehicle per day: E = vehicle-km × e / in-service, where e is the battery
  energy per km.
- Overnight, in the 24 − H hours without service, a vehicle takes back at most
  O = min(B, P × (24 − H) / vehicles per charger): its usable battery B, or its share of a
  charger's output in that window.
- The rest, E − O, is charged by day: (E − O)/P hours per in-service vehicle. The charging reserve
  is then ceil(in-service × (E − O)/(P × H)).
  - This assumes daytime charging is spread over the service day, a conservative choice. Absorbing
    it in off-peak idle time is the low-cost case.
  - Because of this overnight limit, vehicles per charger acts both ways: fewer chargers cost less
    but move charging into the day.

**Cost categories and formulas** (SGD per day).

| Category | Formula | Class |
|---|---|---|
| Vehicles | Total fleet × [annuity(price, life, residual, r) or lease] / 365 | fixed |
| Energy | Vehicle-km × e / charging efficiency × electricity price | distance |
| Maintenance | Vehicle-km × per-km cost + total fleet × fixed per vehicle-year / 365 | distance + fixed |
| Cleaning | Total fleet × per vehicle-day | fixed |
| Insurance and permits | Total fleet × per vehicle-year / 365 + programme fixed / 365 | fixed |
| Software and communications | Total fleet × per vehicle-month × 12 / 365 + control-centre fixed / 365 | fixed |
| Staff | Remote operators, field support and any onboard staff (see below) | staff |
| Charging and depot | Chargers × annuity(charger) / 365 + total fleet × depot space per vehicle-year / 365 + site fixed / 365 | fixed |

**Staff.**
- Remote operators per hour = ceil(vehicles in service / vehicles per operator), with a minimum
  per hour.
- Field staff per hour = ceil(vehicles in service / vehicles per field staff).
- Hours × fully loaded hourly cost.
- **Three staffing cases, each a separate switch, never mixed into one cost range:**

  | Case | Who staffs the service |
  |---|---|
  | `onboard` | A safety operator on every vehicle in service, plus a control room monitoring at its own ratio. This is the current Singapore pilot requirement (LTA, MOT; evidence register) |
  | `remote_with_attendant` | Remote operators at the remote ratio, plus an attendant on every vehicle. This is LTA's stated next phase for its autonomous public buses |
  | `remote` | Remote operators only. Singapore's one precedent is a private resort loop |

**Reported per option.**
- Daily cost by category and its fixed, distance and staff shares.
- Cost per completed ride and per passenger-km.
- Total, in-service and unavailable fleet; unavailable vehicle-hours.

**Bus.**
- A cost per bus-km (and/or per bus-hour), with its inclusions stated.
- Applied to the in-area bus-km, and to the withdrawn services in B(ii).

**Cases.**
- Every parameter has `low_cost`, `central` and `high_cost` values. "low_cost" is the value that
  lowers cost, so a longer life is a low-cost value.
- The low, central and high cases take that column for every parameter.
- One-at-a-time swings and thresholds use the same file.

## 8. Parameter file schema (`data/parameters/cost_cases.json`)

```json
{
  "currency": "SGD", "price_year": 2026, "days_per_year": 365, "gst": "excluded",
  "parameters": {
    "<id>": {
      "unit": "SGD per vehicle",
      "low_cost": 0, "central": 0, "high_cost": 0,
      "by_capacity": {"4": {"low_cost": 0, "central": 0, "high_cost": 0}, "10": {}, "20": {}},
      "basis": "measured | supplier | contract | statistic | assumption | derived",
      "sources": ["S01"], "note": "conversion and applicability"
    }
  },
  "switches": {"acquisition": "purchase", "staff_mode": "remote", "lease_includes": []}
}
```

- `by_capacity` is used instead of the top-level values when a parameter depends on vehicle size.
- Every `sources` id resolves to a row of `data/parameters/cost_register.csv`.

Parameter ids (units fixed here):

| Group | Ids |
|---|---|
| Vehicle | `veh_price` (SGD/vehicle, by capacity), `veh_life_years` (years), `veh_residual_share` (fraction), `lease_sgd_per_vehicle_year` (SGD), `discount_rate_real` (fraction) |
| Energy | `energy_kwh_per_km` (kWh/km at the battery, by capacity), `battery_usable_kwh` (kWh, by capacity), `charging_efficiency` (fraction), `electricity_sgd_per_kwh` (SGD/kWh), `charger_power_kw` (kW) |
| Maintenance | `maint_sgd_per_km` (SGD/km, by capacity), `maint_fixed_sgd_per_vehicle_year` (SGD) |
| Cleaning | `cleaning_sgd_per_vehicle_day` (SGD) |
| Insurance and permits | `insurance_sgd_per_vehicle_year` (SGD), `permit_fixed_sgd_per_year` (SGD) |
| Software and communications | `software_sgd_per_vehicle_month` (SGD), `comms_sgd_per_vehicle_month` (SGD), `control_centre_fixed_sgd_per_year` (SGD) |
| Staff | `vehicles_per_remote_operator` (ratio), `min_remote_operators` (persons), `remote_operator_sgd_per_hour` (SGD/h, fully loaded), `vehicles_per_field_staff` (ratio), `field_staff_sgd_per_hour` (SGD/h), `onboard_staff_sgd_per_hour` (SGD/h) |
| Charging and depot | `charger_sgd_each` (SGD incl. installation), `charger_life_years` (years), `vehicles_per_charger` (ratio), `depot_sgd_per_vehicle_year` (SGD), `depot_fixed_sgd_per_year` (SGD) |
| Reserve | `maintenance_spare_ratio` (fraction) |
| Bus | `bus_sgd_per_bus_km` (SGD/bus-km) and/or `bus_sgd_per_bus_hour` (SGD/bus-hour), with inclusions in `note` |
| Social (separate) | `vot_ivt_sgd_per_hour` (SGD/h), `wait_time_weight` (multiplier) |

## 9. Outputs and interfaces

| Path | Content | Owner |
|---|---|---|
| `docs/phase2/definitions.md` | This file | lead |
| `data/parameters/cost_register.csv` | Source register, one row per source figure | evidence research |
| `docs/phase2/sources.md` | Evidence notes, conversions, applicability, missing evidence | evidence research |
| `data/parameters/cost_cases.json` | Low, central and high values used by the model (schema §8) | evidence research proposes, lead approves |
| `pipeline/yishun/costs.py`, `tests/test_costs.py` | Cost formulas, fleet estimate, thresholds | cost model |
| `pipeline/yishun/phase2/` | Option C assignment, experiments, bus allocation, exports | lead |
| `data/processed/phase2/<experiment>/` | `runs.parquet` (one row per run), `hourly.parquet`, `groups.parquet`, `config.json` (jobs + provenance) | lead |
| `data/processed/phase2/summary.json` | Comparison, costs, thresholds, sensitivity | lead |
| `web/public/data/phase2.json`, web Phase 2 section | Page data and section | results and presentation |
| `docs/phase2/report.md` | Research report | lead with results and presentation |

- Every result file records its provenance: model key, input digests, graph size, calibration,
  demand months, seeds, git revision.
- **Nothing is published or deployed. Pushes go only to the working branch.**

## Change log

- 22 Oct 2026: first version.
- 22 Oct 2026: availability estimate limits the overnight top-up to what the chargers deliver in
  the 24 − H hours without service (the cost-model review found 3 h overnight with H ≈ 21 h).
- 22 Oct 2026: fifteen internal-only services (117A and 811A added by `phase2/bus_allocation.py`).
- 23 Oct 2026: three staffing cases (the AV evidence found LTA's stated next phase: remote
  operation with an onboard attendant).
- 23 Oct 2026: the cost swings also swing the optional staff parameters where they act (the
  attendant wage, and the monitoring ratio with an operator on board); before, the attendant wage
  was missing from the sensitivity of the remote-plus-attendant case.
- 23 Oct 2026, after the independent review (`review.md`):
  - **Bus model.** A rider boards a looping line at whichever visit of the stop gives the
    shortest ride, not at its first visit (figure-of-eight feeder 812). The bus model's version
    enters the model cache key: the model key is now `0cd6fcca7d4d`. Every Phase 2 grid was re-run,
    and Phase 1's experiments were re-run on the same graph and bus model, so both phases now share
    one model.
  - **Stress tests.** B also runs under C's decline rule, and the base case on the stress tests'
    own three days.
  - **Bus costs.** B (ii)'s avoided bus cost is reported at the full resource cost and at the
    operator fee only (section 6).
  - **Inputs.** LTA's bus stops, services and routes are pinned in `data/processed/lta/`.
