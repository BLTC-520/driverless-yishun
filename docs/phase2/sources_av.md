# Phase 2 evidence: the autonomous-shuttle side

*Evidence research for the shuttle cost and operating parameters of Phase 2 (definitions.md §5, §7,
§8). Accessed 22–23 Oct 2026. Source rows are in `data/parameters/register_av.csv`: A01–A74 are
source figures; A75–A93 each state one of this study's assumptions, with its value and reasoning,
so that every proposal entry resolves to at least one row. Proposed values are in
`data/parameters/proposed_av.json` (a proposal; the lead approves). Wages are priced by the
Singapore researcher (`proposed_sg.json`): this file defines roles and ratios only.*

**Conventions.**
- SGD, 2026 prices, excluding GST. A foreign figure is converted at the MAS annual-average rate of
  its price year, then brought to 2026 with SingStat CPI (all items) — factors in §2.
- In the register, `low`/`central`/`high` are the numeric range of *that source's* figure. In the
  proposal file, `low_cost`/`high_cost` follow cost direction (a longer life, a bigger battery or
  a higher vehicles-per-operator ratio is a *low-cost* value).
- Evidence types are those of the brief. Legal and official texts are typed `statistic`
  (official source), because the list has no "regulation" type. Third-party analyst estimates
  that are neither peer reviewed nor official are typed `assumption`.
- "Secondary" in a register row means the figure was read in a report of the primary source,
  not in the primary source itself. Every secondary row says so in `applicability` or
  `publisher`.

## 1. Prioritised missing-parameter list

Ranked by how far each parameter can move the C − A cost (which equals the shuttle cost, §6).
Indicative magnitudes are per vehicle-day for a 10-seat shuttle in service ~20 h and driving
~350 km a day (the Phase 1 fleet's average duty: 160,133 km / 450 vehicles), before wages.

| Rank | Parameter(s) | Why it matters | Status after this research |
|---|---|---|---|
| 1 | Staff model, `switches.staff_mode` | Onboard: ~20 staff-hours per vehicle-day. Remote at 1:10: ~2. This switch alone can change the shuttle cost two- to three-fold | **Current requirement known** (operator on board at all times: LTA, MOT). Future: framework stated, a 1:N ratio not published; LTA's bus pilot plans an onboard customer service officer even after remote operation starts |
| 2 | `vehicles_per_remote_operator`, `min_remote_operators` | In remote mode 1:3 vs 1:40 is a 13× difference in control-room hours | Ratios from abroad only (3 to ~43); proposal is an explicit assumption |
| 3 | `veh_price` by class, `veh_life_years`, `veh_residual_share` | Capital ~S$130–600 per vehicle-day across the range (at 4 % real, illustration) | 10-seat: several transaction prices. 4- and 20-seat: thinner. Life: supplier accounting and claims |
| 4 | `maintenance_spare_ratio`; charging-reserve inputs (`energy_kwh_per_km`, `battery_usable_kwh`, `charger_power_kw`) | Both multiply every fleet-proportional cost. Central 10-seat inputs imply a charging reserve of ~10 % of the in-service fleet | FTA norm and one measured AV availability; energy from supplier specs, one measurement, one peer-reviewed model |
| 5 | `maint_sgd_per_km`, `maint_fixed_sgd_per_vehicle_year` | Distance-heavy service: ~S$35–90 per vehicle-day | Peer-reviewed per-km estimates and measured bus costs; AV sensor upkeep is an assumption |
| 6 | `vehicles_per_field_staff` | Rescue drivers and technicians scale with the fleet | No published ratio: assumption |
| 7 | `insurance_sgd_per_vehicle_year`, `permit_fixed_sgd_per_year` | Mandatory; premiums unpublished | Legal requirement known; premium anchored on an official taxi statistic (Hong Kong) |
| 8 | `software_sgd_per_vehicle_month` | Annual AV support fees exist but are unpublished | Fee structure known (WeRide); level bracketed by a derived lower bound |
| 9 | `cleaning_sgd_per_vehicle_day` | ~S$4–30 per vehicle-day | Time basis (peer-reviewed) × PWM wage |
| 10 | `control_centre_fixed_sgd_per_year`, `comms_sgd_per_vehicle_month` | Fixed or small | Assumptions with partial anchors |
| 11 | `charger_sgd_each`, `charger_life_years`, `vehicles_per_charger`, depot m² per vehicle | Small per vehicle-day; grid connection is the unknown | ICCT cost study; LTA parking code; assumptions |

## 2. Conversion factors used (for reconciliation with the other researcher)

- **MAS** annual average exchange rates, S$ per unit (per 100 for CNY, JPY, CHF, AUD, HKD),
  from the MAS statistics page (frequency Yearly, "Avg for Period"):

  | Year | EUR | GBP | USD | CNY/100 | JPY/100 | CHF/100 | AUD/100 | HKD/100 |
  |---|---|---|---|---|---|---|---|---|
  | 2017 | 1.5589 | 1.7782 | 1.3807 | 20.43 | 1.2313 | 140.26 | 105.85 | 17.72 |
  | 2018 | 1.5931 | 1.8008 | 1.3491 | 20.40 | 1.2214 | 137.93 | 100.84 | 17.21 |
  | 2019 | 1.5272 | 1.7415 | 1.3642 | 19.75 | 1.2519 | 137.30 | 94.81 | 17.41 |
  | 2020 | 1.5744 | 1.7697 | 1.3792 | 20.00 | 1.2922 | 147.04 | 95.19 | 17.78 |
  | 2021 | 1.5890 | 1.8484 | 1.3440 | 20.84 | 1.2237 | 146.97 | 100.90 | 17.29 |
  | 2022 | 1.4514 | 1.7032 | 1.3789 | 20.50 | 1.0538 | 144.47 | 95.74 | 17.61 |
  | 2023 | 1.4523 | 1.6701 | 1.3431 | 18.97 | 0.9573 | 149.54 | 89.22 | 17.16 |
  | 2024 | 1.4457 | 1.7078 | 1.3360 | 18.56 | 0.8831 | 151.84 | 88.19 | 17.12 |
  | 2025 | 1.4765 | 1.7227 | 1.3066 | 18.18 | 0.8739 | 157.63 | 84.27 | 16.76 |
  | 2026* | 1.4851 | 1.7196 | 1.2787 | 18.74 | 0.8068 | 160.82 | 89.97 | — |

  *2026: mean of MAS monthly averages January–September 2026 (no annual figure yet). No row
  in the register uses a 2026 foreign-currency figure.
- **SingStat CPI**, all items, 2024 = 100 (Table Builder M213751, monthly; annual = mean of the
  months; last update 23 Sep 2026): 2015 85.046 · 2016 84.596 · 2017 85.084 · 2018 85.457 ·
  2019 85.942 · 2020 85.794 · 2021 87.781 · 2022 93.163 · 2023 97.666 · 2024 100.000 ·
  2025 100.903 · **2026 = 102.426 (mean of January–August 2026)**.
  Factors to 2026: 2017 ×1.2038, 2018 ×1.1986, 2019 ×1.1918, 2020 ×1.1939, 2021 ×1.1668,
  2022 ×1.0994, 2023 ×1.0487, 2024 ×1.0243, 2025 ×1.0151.
- Statutory SGD fees still in force in 2026 are not CPI-uplifted. Each register row shows its
  conversion string.
- **Reconciliation.** These factors are identical to the Singapore researcher's rows G201–G272
  (CPI 2015–2026; USD, EUR, CNY, JPY, GBP 2015–2026). CHF, AUD and HKD are used only here and come
  from the same MAS page.

## 3. Operating requirements and staff

### 3.1 What Singapore requires today (current pilot requirement)

- **Legal basis.** AV trials and "special use" run in a regulatory sandbox under Road Traffic Act
  s.6C–6E and the Road Traffic (Autonomous Motor Vehicles) Rules 2017 (A01–A05). LTA sets
  conditions case by case. Rule 9(2) lists, among others, a *qualified safety driver seated in
  the vehicle* or a *qualified safety operator* who monitors and can take over, and bans on
  passengers or on hire and reward. Liability insurance is mandatory (r.14). A security deposit
  of at least S$1.5 million is allowed only if insurance cannot be obtained (r.15). A data
  recorder must run at all times, and its data be kept for 3 years (r.17). The authorisation fee
  is S$27 per vehicle (r.7).
- **Assessment path.** Vehicles pass a closed-circuit test at CETRAN (LTA's "Milestone 1"), then
  on-road preparation with a safety operator, then passenger service (A08, A72). The Deployment
  Readiness Assessment (DRA) sets technical-performance and public-acceptance metrics before
  passengers are carried and before driverless operation, including distance driven on the
  deployment route without safety-operator intervention. Thresholds are not published.
  TR 68 (2021) is under review, and deployments continue under the existing regime (A11).
  MOT plans to table an "AV Act" in 2027 (A06).
- **What the Punggol pilots do.** LTA: a safety operator is on board "at all times" in the
  preparatory phase, the community-ride phase, and the commercial passenger service ("Safety
  operators will continue to be on board at all times"). All shuttles are also "monitored in
  real time" (A08). Parliament: "For a start, a safety operator will be on board the AV at all
  times" (A09). Grab runs routes 1 and 3 on WeRide's platform; ComfortDelGro runs route 2 on
  Pony.ai's platform; vehicles have 5–8 seats.
- **LTA's autonomous public-bus pilot (contract PT832, 2025)** used the same rule: a safety
  operator on board at all times in the initial phases, with LTA monitoring in real time (A73).
- **Current pilot requirement for the model: `staff_mode = onboard`.** One safety operator on
  every vehicle in service for every service hour, plus a real-time monitoring function. The
  onboard case is evidence, not an assumption.
  - The onboard case still needs a control room. The schema has one ratio for remote operators,
    so a separate, looser monitoring ratio for onboard mode is proposed as a new id
    (`vehicles_per_monitor_onboard_mode`: 20, range 10–50, assumption A79). If the lead does not
    adopt it, use `min_remote_operators` alone in onboard mode.

### 3.2 Possible future arrangements (kept separate from the current requirement)

- **Stated direction, not yet practice on Singapore public roads.** MOT: under the current DRA
  phase an onboard operator stays while remote operations are tested; "we expect ROs to be
  deployed in lieu of SOs for safety assurance upon full deployment", and one RO may oversee
  several AVs ("1:N") "conditional on the technical and operational readiness". An SO and an RO
  run together only during the assessment phase (A06).
- **LTA's next phase for autonomous public buses keeps a person on board.** After the bus has
  shown it operates "smoothly and safely", "a remote operator will monitor the operation
  continuously in a remote control centre. In place of an onboard safety operator, a customer
  service officer will be deployed onboard to assist commuters" (A73). Bus captains are retrained
  as safety operators.
- **Precedent for no one on board.** In July 2025 LTA approved WeRide's Robobus at Resorts World
  Sentosa to run without a safety officer after assessing its remote operations; LTA's CTO said
  companies that pass "may proceed to remove the onboard safety operator requirement and replace
  it with constant remote monitoring instead" (A10). That is a fixed 12-minute loop inside a
  resort estate, so it shows the path, not a ratio for public roads.
- **Proposed staff cases (report separately, never mixed):**
  1. `onboard` — current requirement: one safety operator per vehicle in service + monitoring.
  2. `remote_with_attendant` — LTA's stated next phase for buses: remote operators at 1:N plus
     one customer service officer per vehicle in service. This needs a customer-service wage
     from the other researcher and is not one of the current switch values; it can be run as
     `onboard` staffing at the attendant wage plus the remote-operator hours.
  3. `remote` — unattended operation after assessment (RWS precedent), the lowest-cost case.
- **No Singapore remote ratio is published.** Ratios reported elsewhere (remote function only,
  excluding field staff):

  | Source | Ratio (vehicles per remote person) | Context |
  |---|---|---|
  | China MoT guideline, Dec 2023 (A16) | ≤ 3 (regulatory floor) | Fully driverless taxis in designated areas; **buses still need one person on board** |
  | Eiheiji, Japan (A17) | 3 | First Level 4 service; 12 km/h on a dedicated path |
  | Cruise, 2023 (A13) | 15–20 | San Francisco robotaxi; assistance session every 4–5 miles, 2–4 % of driving time |
  | Pony.ai (A15) | 20 (Q1 2025) → 30 (end-2025 target) | China robotaxi; ComfortDelGro's Punggol platform |
  | WeRide (A14) | 10 (2024) → 40 (2025) | China robotaxi; Grab's Punggol platform |
  | Waymo (A12) | ~25–43 | ~70 agents on duty for >3,000 vehicles; event-driven, no continuous monitoring |

- **Conflict and resolution.** The ratios differ by an order of magnitude because they describe
  different jobs. Waymo, Cruise, WeRide and Pony agents answer requests raised by the vehicle;
  they do not watch each vehicle. LTA describes "constant" or "continuous" remote monitoring
  (A10, A73), and the Chinese 1:3 rule and the Eiheiji service are continuous-monitoring
  arrangements. Proposal (`basis = assumption`, stated in A76, informed by the table):
  - `high_cost` = 3 (strictest regulatory and first-service arrangement);
  - `central` = 10 (WeRide's 2024 China ratio; near the geometric mean of 3 and 40; below
    Cruise's 15–20, which followed years of driverless testing);
  - `low_cost` = 40 (the Punggol supplier's 2025 China figure, close to Waymo's).
- **Minimum control-room staffing** (`min_remote_operators`): no source gives one. A staffed
  safety function needs at least two people on duty so that one can handle an incident while
  the other keeps monitoring: 2 (range 1–3), assumption (A77). Waymo runs four geographically
  redundant centres; Aurora uses 12-hour shifts with mandatory breaks (Markey annex, A12).
- **Field support and rescue** (`vehicles_per_field_staff`): no published ratio. MOT names the
  roles (safety operators, remote operators, engineers, technicians; A09). Waymo's US event
  response team handles collisions, police and towing remotely and works with local service
  staff (A12). Japan's 2023 Level 4 law requires someone who can be sent to the scene after an
  incident (no ratio). Proposal: one field technician/rescue driver per 20 vehicles in service
  (range 1:10–1:40), assumption (A78); a floor of two on duty for a 21 km² town is suggested (no
  schema id). A total-staff figure of "1.5 workers per vehicle" for Cruise (New York Times, via
  secondary reports) could not be verified and is not used.

### 3.3 Roles for the wage researcher

| Role | Used in | Definition |
|---|---|---|
| Onboard safety operator | `onboard` case, every vehicle in service | Trained driver seated in the AV who monitors the system and takes over or triggers an emergency stop (MOT Table 1, A06). Punggol and the bus pilot retrain taxi/private-hire drivers and bus captains (A73) |
| Customer service officer (onboard attendant) | `remote_with_attendant` case | Rides on board to assist passengers; no driving duty (A73) |
| Remote operator (control-room safety operator) | `remote` cases; real-time monitoring in `onboard` mode | Monitors several AVs continuously from a control centre and responds to alerts per SOP (A06, A73); MOT is considering vocational licences for SOs and ROs |
| Field support technician / rescue driver | all cases | Drives to a stopped vehicle, recovers or moves it manually, does first-line sensor cleaning and fixes; must hold the licence class for the vehicle |
| Cleaner | all cases (per vehicle-day, §7) | Depot interior cleaning and in-day checks |

## 4. Vehicle price, lease, life and residual

### 4.1 Evidence (SGD 2026)

| Class | Source | SGD 2026 | Type | Notes |
|---|---|---|---|---|
| 10 | WeRide average realised sale price 2023 (A19) | 490,000 | contract value | RMB 54.2m / 22 units (19 robobuses, 3 robotaxis); vehicle + L4 kit; services billed separately |
| 10 | WeRide average realised sale price 2022 (A18) | 754,000 | contract value | RMB 337.7m / 101 units (90 robobuses, 11 robotaxis) |
| 10 | Navya list price 2018 (A22) | 496,000 | supplier (secondary) | 15 passengers, 25 km/h |
| 10 | Navya purchase, Italy 2019 (A23) | 546,000 | supplier (secondary) | |
| 10–20 | Holon Mover, JTA 2025 (A26) | 542,000 | contract value (reported) | 15 passengers; board-authorised; delivery 2027 |
| 10 | Japan Digital Agency example 2023 (A29) | 552,000–803,000 | statistic (secondary) | Imported shuttle, incl. some retrofit |
| 20 | Karsan e-ATAK, Campania order 2025 (A65) | 553,000 | contract value (secondary) | **Non-autonomous** 8 m base EV |
| 20 | Japan small AV bus, TIER IV via MLIT 2025 (A27) | 798,000 | statistic | ≤100 units/yr; conventional small bus ~¥25m |
| 20+ | Japan MOF audit, medium/large AV bus (A28) | 959,000 | statistic | Programme average, FY2022–24 |
| 16-seat | LTA PT832 (A72) | 1,380,000 per bus | contract value, **bundled** | Bus + 3 years of fleet/remote systems, chargers, AV hardware/software, maintenance and support |
| 20 | Ongel et al., 30-pax AEV bottom-up (A33) | ~253,000 | peer-reviewed estimate | 3,000 units/yr; no AD software |
| 4 | Baidu RT6 invoice 2024 (A30) | 39,000 | supplier (secondary) | Chinese domestic; not purchasable in Singapore |
| 4 | Waymo, third-party estimates (A32) | 99,000–265,000 | assumption (secondary) | 6th gen ~US$75–110k; I-Pace era ~US$150–200k |
| 4/10/20 | Bösch et al., mature technology (A34–A36) | 46,000 / 87,000 / 92,000 | peer-reviewed estimate | Conventional vehicle + 20 %; a long-run floor only |

- **Bundling check.** WeRide's product revenue is the vehicle with its L4 hardware and embedded
  software; system upgrades, maintenance and repair, fleet management and remote assistance are
  sold separately as an annual fee (A20). So A18/A19 are vehicle prices and a separate
  software/support fee is added (§9). LTA's PT832 sum (A72) and the H-GAC EasyMile price (A25)
  bundle systems, maintenance and (EasyMile) operation, so they are **not** used as vehicle
  prices. PT832 is used only as a cross-check: at the central inputs, a 16–20-seat vehicle
  (S$0.75m) plus three years of software (S$36k), maintenance (~S$0.1m) and its share of
  systems and chargers is of the same order as S$1.38m per bus.
- **Conflicts.** The 10-seat evidence spans S$490k–800k. The spread is real: WeRide's own average
  price fell by a third from 2022 to 2023, and Japanese public purchases carry import,
  homologation and retrofit costs. The engineering estimates (Ongel, Bösch) are far lower because
  they assume mass production and no software charge; they inform the low end only.
- **Proposal** (`veh_price`, by class): 10-seat central **S$540k** (median of six market
  observations), low S$300k (derived volume-production price; assumption A89), high S$800k.
  20-seat central S$750k (Japan small AV bus; e-ATAK base + AV kit), low S$400k, high S$1.0m.
  4-seat central S$150k, low S$60k, high S$270k (weak evidence).
- **Not included in any price:** Singapore registration taxes and COE, import duty, GST, and
  one-off site set-up (Japan: ¥10–20m per site for maps, ~¥100m per deployment for tuning and
  permits; A69, A70, costed under `permit_fixed_sgd_per_year`). Whether AV shuttles need a COE,
  and in which category, is a policy question (§12).

### 4.2 Life and residual

- WeRide depreciates motor vehicles over 5 years (A21); Baidu says its RT5 "can be operated
  reliably for five years" (A31); Pony.ai designs its Gen-7 kit for 600,000 km (A49), which at
  Yishun utilisation (~100,000–130,000 km a year) is 4.6–6 years. Singapore buses have a
  17-year statutory life, but the AV kit, not the body, sets the economic life here.
  Proposal: central 5, low_cost 7 (with a mid-life sensor refresh inside maintenance; A93),
  high_cost 4 years.
- Residual value: no AV resale evidence; rapid technical obsolescence. Proposal 5 % (0–10 %),
  assumption (A80).

### 4.3 Lease

No vehicle-only lease price was found. Navya's ~€13,000/month short-term rental (S$284k a year,
A24) has unstated inclusions; EasyMile's US$8,000–27,000/month (A25) bundles operation and
maintenance; US DOT notes that leases and purchases often include software updates and that
subscriptions may include staff and maintenance (A74). The proposal derives a vehicle-only
lease from the purchase case: price × CRF(4 % real lessor cost of capital, life) × (1 + margin
5/10/15 %), giving S$133k a year central for the 10-seat class (S$52.5k–284k); `lease_includes`
stays empty.

## 5. Energy, battery and charging

| Class | Source | kWh/km at battery | Type | Notes |
|---|---|---|---|---|
| 10 | Navya Arma, Mcity (A40) | 1.00 | measured result | 31 km/day; ~6 kW auxiliary load dominates; per-km value not transferable |
| 10 | WeRide Robobus (A41) | 0.35–0.58 | supplier (secondary) | 69.2 kWh pack; 120 km typical range (8 h) vs ~200 km on the product page |
| 20 | Ongel et al. (A44) | 0.62 | peer-reviewed estimate | 6 m, 30 pax, Singapore BRT cycle, 13.4 kWh/h at 21.7 km/h |
| 20 | Karsan Autonomous e-ATAK (A61) | 0.73 | supplier | 220 kWh, up to 300 km; DC 80 kW |
| 4 | EPA, 2020 Jaguar I-Pace (A64) | 0.24 | measured result (test) | Base vehicle only; no AV load, no tropical HVAC |

- **Conflict and resolution.** WeRide's two ranges imply 0.35 and 0.58 kWh/km. The Navya
  measurement shows why: auxiliary loads (HVAC, sensors, compute) of several kW are paid per
  hour, not per km. The Yishun fleet averages ~18 km/h over the service day, so 3–6 kW adds
  0.17–0.34 kWh/km to traction (assumption A90). Proposal (by class, `derived`): 4-seat 0.30 (0.22–0.40),
  10-seat 0.50 (0.35–0.65), 20-seat 0.70 (0.55–0.95).
- **Battery (usable, life-average).** 10-seat: 69.2 kWh gross → 58 kWh central (90 % window ×
  ~93 % average health), 66 new, 50 late-life (A42). 20-seat: 220 kWh gross (A62) → 180 central;
  Ongel's 120 kWh 6 m vehicle (A45) as the high-cost bound. 4-seat: no figure was collected for
  the robotaxis used in Singapore; 70 (55–85) kWh is an assumption (A88).
- **Charging efficiency:** 0.92 central (A92); 0.95 (Ongel's charger efficiency, A46) and 0.88 (below
  ORNL's 0.90 AC assumption, A47) as bounds. No measured DC depot efficiency was found.
- **Charger power (vehicle acceptance):** WeRide Robobus full DC charge in about one hour,
  ~60–70 kW (A43); e-ATAK DC 80 kW (A63). Proposal 60 kW (4- and 10-seat), 80 kW (20-seat).
- **What the inputs imply for the charging reserve** (§7 of definitions, illustration at
  ~350 km/day and H ≈ 20 h): 10-seat E ≈ 175 kWh vs B = 58 → ~2 h of daytime charging at 60 kW
  → reserve ≈ 10 % of the in-service fleet; 4-seat ≈ 3 %; 20-seat ≈ 4 %. Option C's
  km per vehicle will differ; the lead's formula applies.

## 6. Maintenance

- **Per km.** Bösch et al. (peer reviewed; Swiss fleet electric vehicles; VAT removed; AV
  assumed to change nothing) give 0.07 (4-seat), 0.12 (10) and 0.12 (20) S$/km without battery
  replacement, and 0.12 / 0.21 / 0.22 with it (A37–A39). Measured full-size US battery buses
  cost S$0.48–0.58/km (A50–A52; read via search results because nrel.gov was blocked, so marked
  secondary). Singapore workshop labour is cheaper than Swiss or US labour, but AV vehicles are
  low-volume with costly parts.
  - Proposal (`derived`): 4-seat 0.09 (0.06–0.15), 10-seat 0.15 (0.10–0.25), 20-seat 0.20
    (0.13–0.35) S$/km. With a 5-year life no traction-battery replacement is included.
- **Fixed AV upkeep** (`maint_fixed_sgd_per_vehicle_year`: sensor cleaning and calibration,
  lidar/camera repair, inspections): no public figure (McKinsey describes it qualitatively as
  significant early on). Proposal S$8,000 (3,000–20,000) a vehicle-year, about 1.5 % (0.5–4 %)
  of the 10-seat price, assumption (A81).
- **Bundling.** WeRide's annual support fee includes maintenance and repair (A20). If a supplier
  fee is costed as bundled, set the bundled maintenance categories to zero (definitions §5).

## 7. Cleaning

- Ongel et al.: a 12 m bus gets ~15 minutes of service-line cleaning once a day, scaled by
  floor area for smaller vehicles (A48). Bösch et al. assume shared AVs are cleaned after every
  40th trip, which makes cleaning almost a third of a robotaxi's operating cost; that rule was
  built for car-sharing and is too heavy for a pooled shuttle, so it sets the high case only.
- Wage: PWM general cleaner S$2,080 a month basic from 1 July 2026 (outdoor/restroom S$2,495)
  (A54). Loaded rate assumed ~S$17/h (×1.30 on-costs, ×1.2 contractor margin; S$13–22/h).
  **Reconcile with the wage researcher.**
- Proposal (`derived`; assumptions in A91) = minutes × rate + consumables: 4-seat S$10.5
  (4.25–25), 10-seat S$11.9 (4.25–25), 20-seat S$14.75 (5.33–30.5) per vehicle-day (central
  30/35/45 minutes).
- **Comparison with the Singapore researcher's value, which the lead keeps** (wage-based;
  `proposed_sg.json`, G37–G52):

  | Class | Singapore researcher: low / central / high | This file: low / central / high |
  |---|---|---|
  | 4 | 2.5 / 4.2 / 12.3 | 4.25 / 10.5 / 25.0 |
  | 10 | 3.5 / 6.3 / 17.4 | 4.25 / 11.9 / 25.0 |
  | 20 | 5.0 / 8.9 / 25.1 | 5.33 / 14.75 / 30.5 |

  - Both use the same formula and the same wage floor (PWM S$2,080 from July 2026). The loaded
    rates are close at the centre (S$15.9/h there; S$17/h here, which adds a contractor margin).
    The difference comes from time and consumables: 20 vs 35 minutes and S$1 vs S$2 for the
    10-seat central case. Their high case uses a higher wage (motor-vehicle cleaner median,
    S$30.8/h) with fewer minutes; this file uses more minutes at S$22/h.
  - The gap is S$5.6 per vehicle-day at the 10-seat centre (~S$2,000 per vehicle-year), small
    next to staff and capital. The longer times here assume an unattended on-demand vehicle
    with in-day checks; with an operator on board (the current case) the shorter times are the
    more plausible ones. Using their value is consistent with this evidence.

## 8. Insurance and permits

- **Requirement.** Liability insurance before and throughout the authorisation, from an insurer
  licensed in Singapore (A03); third-party liability covering death, bodily injury and property
  damage (A09). A S$1.5m security deposit is the fall-back only (A04). MOT expects new risks to
  "translate to higher insurance premiums", and is studying self-insurance and caps on
  cyber-related payouts (A07). LTA's PT832 bus pilot and the Punggol releases give no premium.
- **Premium evidence.** None for AVs in Singapore. The closest official statistic for an
  intensively used passenger vehicle is Hong Kong's average taxi premium: S$7,200 comprehensive,
  S$5,600 third party (2026 SGD; A53). Pony.ai reports insurance as a falling unit cost with
  experience (A15). Proposal (`assumption`, A82): 4-seat S$6,000 (3,000–15,000), 10-seat S$8,000
  (4,000–20,000), 20-seat S$10,000 (5,000–25,000) per vehicle-year.
- **Permits and programme fixed.** The LTA fee is S$27 per vehicle (A02). The real programme
  costs are assessment, safety cases, audits and route mapping: Japan reports ~¥100m per
  deployment for tuning and permits (S$0.89m; A69) and ¥10–20m per site for 3D maps (A70).
  Proposal S$150k a year (30k–400k), assumption (A83).

## 9. Software, communications and control centre

- **Software/support.** No AV licence price is published. WeRide sells robobuses with an annual
  fee covering system upgrades, maintenance and repair, fleet management and remote assistance
  (A20). Its support revenue divided by its whole AV fleet is S$1,200–1,600 per vehicle-month
  (A66, A67); this is a lower bound per paying customer vehicle (the fleet includes WeRide's own
  robotaxis), and it bundles maintenance and remote assistance. Litman's navigation and security
  subscriptions (~S$55/month, A68) are a floor for private cars, not a fleet licence.
  Proposal (`assumption`, A84): S$1,000 (300–3,000) per vehicle-month for the driving-software
  licence and fleet platform alone.
- **Communications.** Business SIMs with unlimited local data cost S$44–64 a month (A55,
  secondary); two carriers for redundancy, video uplink for monitoring and 3-year data retention
  (A05) push the total up. Proposal S$150 (60–400) per vehicle-month, assumption (A85).
- **Control centre fixed.** No Singapore figure. Japanese programmes spend ~¥23m per bus on
  system equipment (A71), i.e. non-vehicle systems are 20–40 % of the vehicle cost at small
  scale. Proposal S$750k a year (300k–2.0m): facility, IT, a redundant site, cybersecurity
  monitoring and ~5 FTE of 24/7 supervision not counted in remote-operator hours; assumption (A86),
  with the wage part to be reconciled.

## 10. Charging and depot equipment

- **Charger cost.** ICCT (2019, US): 50 kW hardware US$28.4k plus installation US$17.7k per
  charger at sites with 6+ chargers → S$75k (2026); 150 kW → S$152k (A56, A57). Excludes grid
  upgrades. Proposal S$80k (40k–160k) for a ~60 kW depot charger; the low value assumes lower
  Asian hardware prices since 2019.
- **Life:** 10 (8–12) years, an explicit assumption stated in A75: the usual planning range for
  DC power electronics; no collected source states a charger life.
- **Vehicles per charger:** 2 (1–3), assumption (A87): a 10-seat shuttle uses ~175 kWh/day; a
  60 kW charger delivers ~240 kWh in a 4-hour night window.
- **Depot space** (for the other researcher's rent): LTA's minimum lot plus half an aisle is
  18.7 m² for a car, 36 m² for a rigid vehicle under 7.5 m and 57.8 m² over 7.5 m (A60). Proposed
  helper `depot_m2_per_vehicle`: 24 / 45 / 72 m² (+25 % for charging, cleaning and servicing
  bays; +50 % high).

## 11. Reserve and availability

- FTA caps spare buses at 20 % of peak vehicles for mature bus fleets (A59).
- The Treasure Island AV shuttle pilot (safety attendant on board, 2023) delivered 78–79 % of
  planned runs and miles against a 95 % goal; 88–106 % in its settled months (A58). That is a
  single-vehicle pilot, so it overstates the spares a fleet needs, but it shows early AV
  reliability is below bus norms.
- Proposal `maintenance_spare_ratio`: 0.15 (0.10–0.25), with the charging reserve computed
  separately (§5).

## 12. Gaps that remain, and evidence needed before a deployment decision

1. **The permitted Singapore 1:N ratio** and the DRA criteria for removing the onboard operator
   on public roads in an HDB town (TR 68 revision; the AV Act of 2027). Without them the remote
   cases are scenarios, not forecasts.
2. **Punggol operating data**: safety-operator and control-room hours, uptime, interventions,
   km per vehicle-day and energy per km (Grab, ComfortDelGro, LTA).
3. **Singapore quotations** for homologated vehicles of each class (WeRide, Pony.ai, BYD/Zhidao,
   Karsan, Holon) with the software licence, support fee and warranty itemised; and the
   registration category, COE and tax treatment of AV shuttles (potentially large for the
   4-seat class; not priced here).
4. **Insurance quotes** for an AV fleet from Singapore insurers.
5. **Depot grid connection** costs (SP Group) for a depot drawing several MW.
6. **Incident rates** (minimal-risk stops and recoveries per 1,000 km) to size field staff.
7. **Maintenance records** of AV fleets (per km and per year) and measured energy use in
   Singapore's climate.
8. The 20-seat class has no Singapore price except the bundled PT832 contract.

**Sources that could not be accessed from this environment:** nrel.gov (NREL bus evaluations;
values taken from search results and marked secondary), the US DOT ITS cost database and FTA
pages (403), METI (403), Axios (403; EasyMile H-GAC prices are therefore secondary), the
Jacksonville Daily Record (403; Holon price read in Jacksonville Today), H-GAC contract
documents (not found), the full SFCTA Loop report (too large; the committee presentation was
used), the Lin et al. ASPLOS paper on AV compute power (connection reset), GeBIZ (not
searched directly; LTA's own release gives the PT832 award).
