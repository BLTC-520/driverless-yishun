# Phase 2 evidence notes: Singapore and bus-side parameters

*Evidence research for the Singapore cost parameters (bus, electricity, wages, depot, discount
rate, conversion factors, social values). Accessed 22–23 Oct 2026. Register:
`data/parameters/register_sg.csv` (source ids G01–G85 for evidence, G201–G272 for CPI and
exchange rates; ids G25–G27 are unused). Proposed values: `data/parameters/proposed_sg.json` (schema of definitions.md §8).
The AV shuttle side (vehicles, AV staffing ratios, software, insurance, energy use) is covered by
the other researcher and is not repeated here.*

Conventions (definitions.md §5): SGD, 2026 prices, excluding GST. A figure is converted at the MAS
annual-average exchange rate of its price year, then brought to 2026 with SingStat CPI (all items).
"2026" CPI is the mean of Jan–Aug 2026 (102.426, 2024 = 100). `low_cost` is the value that makes
cost lower; for the social values (VoT, wait weight) `low_cost` simply means the low value.

Evidence types used: contract value, statistic, supplier specification, measured result,
peer-reviewed estimate, assumption. Secondary sources (news, enthusiast sites, vendor blogs) are
marked "secondary" and are used only where no primary source was found.

## 1. Prioritised missing-parameter list

Ranked by how much each parameter can move the Phase 2 cost result (B, C) or its interpretation.

| # | Parameter(s) | Why it matters | Status |
|---|---|---|---|
| 1 | `onboard_staff_sgd_per_hour`, `remote_operator_sgd_per_hour`, `field_staff_sgd_per_hour`, `attendant_sgd_per_hour` | Staff is the largest shuttle cost when an onboard operator rides every vehicle (one person per vehicle-hour in service, thousands of vehicle-hours a day) and stays large under remote supervision | Found: MOM wage survey (June 2025) + CPF + paid hours; overhead factor is an assumption |
| 2 | `bus_sgd_per_bus_km` (and derived `bus_sgd_per_bus_hour`) | Sets B(ii)'s avoidable bus cost and the bus context cost per ride | Found: LTA tender prices (operator fee) + LTA bus and depot prices (assets); per-km rests on a derived bus-km denominator |
| 3 | `vot_ivt_sgd_per_hour`, `wait_time_weight` | Decide whether passenger-time savings justify the added cost (social side, kept separate) | Found: LTA-commissioned 2015 stated-choice study (Hess et al. 2017) incl. an equity value; 2026 worldwide meta-analysis and UK TAG for the wait weight |
| 4 | `electricity_sgd_per_kwh` | Shuttle energy cost; moderate | Found: SP Group tariffs Q1–Q4 2026, EMA USEP |
| 5 | `discount_rate_real` | Vehicle and charger annuities; bus asset add-on | No Singapore official rate; international guidance + SGS yields |
| 6 | `cleaning_sgd_per_vehicle_day` | Moderate for large fleets | Wage found (PWM, MOM); minutes per vehicle is an assumption |
| 7 | `depot_sgd_per_vehicle_year`, `depot_fixed_sgd_per_year` | Moderate | Industrial rent (JTC data, secondary report), parking rates (secondary), LTA depot contracts; m² per vehicle from the AV researcher's helper (assumption); site staffing is an assumption with MOM wages |
| 8 | `charger_sgd_each` (cross-check only) | Small | LTA e-bus charging contracts (bundled) |
| 9 | CPI and FX (`cpi_<year>`, `fx_<cur>_<year>`) | Needed for every conversion | Found (SingStat, MAS) |
| 10 | LTA bus service standards | Decide whether a feeder frequency reduction in C has a valid basis | See §9 |

## 2. Bus operating cost (`bus_sgd_per_bus_km`, `bus_sgd_per_bus_hour`)

### 2.1 Which contracts cover Yishun

Yishun's buses run under LTA's Bus Contracting Model (BCM). LTA owns the buses, depots,
interchanges and fleet-management and fare systems, and keeps the fare revenue. Operators are paid
a fee. Yishun's services sit in several packages:

- **Seletar package (SBS Transit)**: holds the Yishun feeders 800, 803, 804, 805, 806, 807
  (and its short workings) 811 and 812, plus Ang Mo Kio/Yio Chu Kang services (29 routes, Seletar
  Bus Depot). First term 2018–2025 (award $480.3M, G08); second term from 16 Mar 2025, awarded
  19 Jul 2024 at $526,249,521.73 for five years (G04).
- **Sembawang–Yishun package (Tower Transit)**: Yishun and Sembawang interchanges, Mandai Depot,
  about 400 buses at tender (G03). Holds feeder 801 and trunk 461 (and 167, 169, 171, 85x, 96x…).
  Awarded 30 Sep 2020 together with Bulim ($1.03bn combined, G02); Tower Transit's price for this
  package alone was $582,062,354 (G01). Run since 5 Sep 2021; the two-year extension was exercised
  (to 2028; Land Transport Guru, secondary).
- Other packages contribute single routes (e.g. 117/117A, SBS Transit; 39, Tampines package).

Of the 15 services that could be withdrawn in B(ii), 12 are in the Seletar package (800, 803–806,
807/807A/807B/807C, 811/811A, 812), two in Sembawang–Yishun (801, 461) and one short working (117A,
SBS Transit, another package). The Seletar price is therefore the most relevant one.

### 2.2 What a BCM contract price includes

LTA's note to every bid table (G01, G04, G08): *"The price for five years comprises one-off
pre-operation costs, as well as the total service fee and lease charges for assets provided by LTA
(excluding any adjustment for inflation, change in wage levels and fuel costs, service variation
or incentive payment during the contract period)."*

| Item | In the operator price? | Evidence |
|---|---|---|
| Bus captains and all operating staff | Yes | LTA scope of contract (G08) |
| Bus maintenance (labour, parts), on-board equipment | Yes (operator "operate, manage and maintain" LTA buses) | G08 |
| Depot and interchange operation and maintenance | Yes | G08 |
| Fuel (diesel) | Yes, with indexation for fuel prices | G11 (service fee indexed to wages, inflation, fuel) |
| Electricity for e-buses | Not stated | gap |
| Operator overheads and margin, pre-operation costs | Yes | G01 note |
| Lease charges for LTA-provided assets | Yes, amount not disclosed | G01 note |
| Purchase of buses | No (LTA buys; G12–G14) | |
| Construction of depots and interchanges, land | No (LTA; G17–G19) | |
| Fleet management, fare collection systems | No (LTA procures) | GeBIZ awards |
| Indexation after bid, incentives, service variations | No | G01 note |
| GST | Not stated; treated as excluded | assumption |

The contract price is therefore an **operator fee**, not a full cost. It is never used as a vehicle
price. LTA-owned assets are added separately (§2.4). Caution: the price contains an undisclosed
"lease charge" for LTA assets; if that charge recovers asset depreciation, adding bus and depot
capital double-counts it in part. The operator-fee-only value is therefore also reported.

### 2.3 Operator fee per bus-km: arithmetic

No source states bus-km per package. The denominator is derived from LTA's own published schedule
(DataMall BusRoutes distances × trips from published headway bands and first/last bus times, the
same rule as `pipeline/yishun/supply.py`, applied to full routes). Check: the 13 Yishun services of
Phase 1 give 15,200 bus-km/day, as in definitions.md. Singapore total: 919,126 scheduled weekday
revenue bus-km; LTA's 2014 daily average was 901,700 (G10). Annual bus-km = weekday bus-km × 350
equivalent weekdays (assumption G28, range 335–365).

| Package (source) | 5-yr price (SGD) | Price yr | Weekday bus-km | SGD/bus-km, bid year | × CPI to 2026 | SGD/bus-km 2026 (365 / 350 / 335 days) |
|---|---|---|---|---|---|---|
| Sembawang–Yishun, TTS alone (G01) | 582,062,354 | 2020 | 82,195 | 4.047 | 1.1939 | 4.63 / **4.83** / 5.05 |
| Bulim + S–Y combined award (G02) | 1,025,102,939 | 2020 | 127,616 | 4.590 | 1.1939 | 5.25 / **5.48** / 5.73 |
| Bukit Merah, SBST (G05) | 476,457,752.80 | 2023 | 54,259 | 5.018 | 1.0487 | 5.05 / **5.26** / 5.50 |
| Jurong West, SMRT (G06) | 411,533,323.80 | 2023 | 45,971 | 5.115 | 1.0487 | 5.14 / **5.36** / 5.60 |
| **Seletar 2nd term, SBST (G04)** | 526,249,521.73 | 2024 | 58,759 | 5.118 | 1.0243 | 5.03 / **5.24** / 5.48 |
| Tampines, Go-Ahead (G07) | 646,244,809.70 | 2025 | 64,740 | 5.704 | 1.0151 | 5.55 / **5.79** / 6.05 |

Example (Seletar): 526,249,521.73 / 5 = 105.25M per year; 58,759 × 350 = 20.57M bus-km per year;
105.25M / 20.57M = 5.118 SGD/bus-km in 2024 prices; × 102.426/100.000 = **5.24 SGD/bus-km (2026)**.

Per bus (where LTA states the fleet): Sembawang–Yishun 582.06M / 5 / ~400 buses = 291,031 SGD per
bus-year (2020) = 347,450 (2026); the combined award 284,751 (2020) = 339,953 (2026).

- Recent awards (2023–2025) cluster at 5.2–5.8 SGD per scheduled revenue bus-km in 2026 prices.
  Sembawang–Yishun alone is lower (4.8): long trunk routes run more km per bus-hour.
- Bulim alone (TTS bid 482.4M, 2020) gives 7.2, but its 2020 route list no longer matches the
  2026 schedule (944 withdrawn, new Tengah routes added to Tower Transit): not used.
- Bid prices exclude indexation. Bringing them to 2026 with CPI follows the study convention; the
  actual indexation uses wage, inflation and fuel indices, so payments in 2026 can differ.
- The fee covers dead running, so dividing by revenue km only (as the model's bus-km are revenue km)
  is consistent.

**Operator fee proposed: low 4.6 (S–Y, 365 days), central 5.2 (Seletar, 350), high 6.0 (Tampines,
335) SGD per bus-km.**

### 2.4 LTA-owned assets added to the operator fee

| Component | Evidence | Arithmetic (2026 SGD) | low / central / high per bus-km |
|---|---|---|---|
| Bus capital | E-bus contracts Dec 2025: single-deck 360 for $150.9M (avg 419,167, G12); double-deck 300 for $171.3M (avg 571,000, G13). 2023: 360 single-deck for $166.4M (462,222, G14). Life 17 years (statutory, G15), residual 0 | Blend 60/40 SD/DD (G29) = 487,143; × CRF(3.5 %, 17) = 0.0790 → 38,505 per bus-year; / 53,024 km per bus-year (919,126 × 350 / 6,067 omnibuses, G16) | 0.40 / **0.73** / 1.36 |
| Depot capital | Simpang depot, Yishun, $387.0M for ~500 buses (774,000 per space, G17); Lorong Halus $313.9M, ≥550 (570,727, G18); Pasir Panjang $385.7M, ~550 (701,273, G19) | Mean 696,180 per bus space (2026); × CRF(3.5 %, 40) = 0.0468 → 32,600 per bus-year; / 53,024 km | 0.25 / **0.62** / 1.45 |
| Fleet-management, fare and on-board systems | GeBIZ 2024 awards: fleet management $65.9M, fare equipment $110.9M, depot ticketing $19.9M, others ≈$28M for ~6,000 buses | ≈ 0.1 SGD/bus-km if spread over 10 years | not added (small; noted) |
| Land | State land; no rent charged | not valued | excluded |

Case definitions: low_cost = all single-deck price, r = 2 %, depot life 50 years, 75,003 km per
bus-year (Sembawang–Yishun); high_cost = all double-deck price, r = 7 %, depot life 30 years,
43,743 km per bus-year (Seletar with an assumed 450 buses). The discount rates match
`discount_rate_real` (§6).

### 2.5 Proposed bus values

| | low_cost | central | high_cost |
|---|---|---|---|
| Operator fee (contract value) | 4.63 | 5.24 | 6.05 |
| + bus capital (LTA) | 0.40 | 0.73 | 1.36 |
| + depot capital (LTA) | 0.25 | 0.62 | 1.45 |
| **`bus_sgd_per_bus_km`, full resource cost** | **5.3** | **6.6** | **8.9** |
| `bus_sgd_per_bus_hour` (derived: × 13.89 km/h in-area mix, 33,871 km / 2,439 h) | 73 | 91 | 123 |

- Inclusions of the full value: operator fee (staff, maintenance, fuel, depot and interchange
  operation, overheads, margin, pre-operation, lease charge) + LTA bus purchase + LTA depot
  construction. Excludes land, LTA's own planning and contract management, fare and fleet
  systems (≈0.1/km), indexation after the bid, incentives, GST.
- Operator fee is 80 % of the central full value.
- Use per bus-km or per bus-hour, never both. The per-hour value is the per-km value restated at
  the in-area speed mix; it adds no information about how costs vary with speed. Slow feeder
  operation (the 15 withdrawable services run 15,246 km in 1,226 h, 12.4 km/h) probably costs more
  per km than package averages, because crew cost follows hours: the high case covers ≈ +35 %.
- For a "payments by LTA" view, use the operator fee row only.

### 2.6 Conflicts and resolutions (bus)

- **$1.025bn vs $1.03bn** (combined award): LTA's release rounds; the bid table gives 1,025,102,939.
- **Lease charges.** Secondary sources say operators pay LTA to lease buses; the SBS Transit 2017
  report shows LTA paying operators a leasing fee for operator-owned buses (negotiated contracts).
  For tendered packages the price "comprises … lease charges for assets provided by LTA". The level is
  not published, so the asset add-on may partly double-count; the operator-fee-only value is the
  lower bound.
- **Seletar fleet**: 380–390 buses at 2018 start (secondary), ~500 projected (secondary); LTA does not
  state it. Only the per-km route (not per bus) is used for Seletar.

## 3. Wages, fully loaded (`onboard_staff_sgd_per_hour`, `remote_operator_sgd_per_hour`, `field_staff_sgd_per_hour`, `attendant_sgd_per_hour`, cleaner)

### 3.1 Wage evidence (MOM Occupational Wage Survey, June 2025, full-time resident employees)

Monthly **gross** wage = basic + overtime + allowances + other regular cash; it excludes employer
CPF and bonuses (G43). Released 30 Jun 2026; Table 4.4 is the Transportation and Storage industry.

| Role in the model | Occupation (SSOC 2024) | Gross P25 | Gross median | Gross P75 | Basic median | Register |
|---|---|---|---|---|---|---|
| Onboard safety operator | Bus driver 83311 (T&S) | 2,700 | 3,919 | 4,881 | 2,509 | G31 |
| (cross-check) | Bus driver 83311 (all industries) | 2,260 | 3,619 | 4,656 | 2,418 | G32 |
| Remote operator (control room) | Road transport operations officer 31597 (T&S) | 3,068 | 3,825 | 4,625 | 2,990 | G33 |
| (alternatives) | Road transport supervisor 31573; train operations officer 31596 (T&S) | 3,339; 3,124 | 3,821; 3,712 | 4,224; 4,374 | 3,134; 3,151 | G34 |
| Field technician / rescue driver | Automotive engineering technician 31212 (T&S) | 2,920 | 3,684 | 4,177 | 2,936 | G35 |
| (alternatives) | Mechanical engineering technician 31151 (T&S); automotive mechanic 72310 (all) | 3,419; 1,600 | 4,546; 2,500 | 5,343; 3,272 | 4,000; 2,375 | G36 |
| Cleaner | Indoor cleaner 91131 (T&S); motor vehicle cleaner/polisher 91220 (all) | 1,600; 2,025 | 1,900; 3,660 | 2,197; 4,154 | 1,807; 2,700 | G37 |
| Cleaner wage floor | Cleaning PWM from 1 Jul 2026, general/indoor (outdoor) | | ≥ 2,080 basic (≥ 2,495) | | | G38 |

Market cross-checks: Grab's "Autonomous Vehicle Safety Operator" advertisement offers SGD 3,500–4,000
(secondary, G45). LTA (3 Jun 2026): new local bus captains' starting pay rises by $450 from
1 Jan 2027, lifting average first-year pay including overtime, allowances and bonuses above $4,000;
local captains were 41 % of the workforce in 2025 (G44).

### 3.2 Loading to employer cost per worked hour

| Factor | Value | Basis |
|---|---|---|
| Bonus / AWS | 1 month of basic (cleaners 0.5) | assumption (G48) |
| Employer CPF | 17 % (age ≤ 55; 16 % 55–60, 12.5 % 60–65) on all pay; OW ceiling $8,000/month in 2026 | CPF Board (G39) |
| Skills Development Levy | 0.25 %, max $11.25/month | SSG/GoBusiness (G40) |
| Other on-costs (medical, insurance, uniforms, training) | 5 % of pay | assumption (G49) |
| Paid hours in a working week | 46.5 (land transport, full-time, 2025: 42.8 standard + 3.7 paid overtime); cleaners 44.8 | MOM (G41) |
| Leave and absence | 14 annual leave + 11 public holidays + 4 sick days = 29 days | Employment Act floors (G42) + assumption (G50) |
| Worked hours per FTE-year | 46.5 × (52.14 − 29/5.5) = **2,179** (cleaners 2,100) | derived |
| Supervision / admin overhead | ×1.15 in high_cost only | assumption (G51), no source |
| Price year | June 2025 wages × CPI 1.0151 → 2026 | G211 |

Formula: hourly = {[12 × gross + bonus months × basic] × (1 + 0.17 + 0.05) + SDL} × 1.0151 / 2,179.
Example (onboard, median): (12 × 3,919 + 2,509) × 1.22 + 135 = 60,559 SGD/yr (2025) → × 1.0151 /
2,179 = **28.2 SGD per worked hour**. Because the gross wage contains the overtime pay of the 46.5
paid hours, the wage and the hours are consistent. Leave cover is inside the hourly rate, so the
model's "hours × hourly cost" already pays for the relief staff a 24/7 roster needs.

### 3.3 Proposed staff values (SGD per worked hour, 2026)

| Parameter | low_cost (P25) | central (median) | high_cost (P75 × 1.15) |
|---|---|---|---|
| `onboard_staff_sgd_per_hour` | 19.7 | **28.2** | 40.4 |
| `remote_operator_sgd_per_hour` | 22.4 | **27.8** | 38.7 |
| `field_staff_sgd_per_hour` | 21.4 | **26.8** | 34.9 |
| cleaner (input to cleaning) | 15.1 | **15.9** | 30.8 |

Sensitivity of the central onboard rate: no bonus 26.8; 2 months' bonus 29.6; on-costs 10 % 29.4;
CPF 12.5 % (age 60–65) 27.2; 44 h/week and 32 leave days 30.2.

Limits:
- Residents only. 59 % of bus captains are foreign; their cost (no CPF, foreign worker levy,
  housing) is not covered. An operator hiring foreign safety operators would face different costs.
- There is no MOM occupation for an AV remote operator. The controller wage is a proxy; a scarce
  specialised role could cost more (the high case allows +39 %).
- Wages are June 2025, brought to 2026 with CPI (study convention). Nominal wage growth has run
  ahead of CPI, so 2026 wages may be 1–3 % higher.

### 3.4 Cleaning (`cleaning_sgd_per_vehicle_day`)

cleaning = minutes per vehicle-day / 60 × cleaner hourly + consumables. Minutes (assumption G52):
4 / 10 / 20 seats = 12 / 20 / 30 (low 8 / 12 / 18, high 20 / 30 / 45); consumables 1.0 SGD per
vehicle-day (0.5–2.0). No source on minutes per vehicle was found.

| Capacity | low_cost | central | high_cost |
|---|---|---|---|
| 4 seats | 2.5 | 4.2 | 12.3 |
| 10 seats | 3.5 | 6.3 | 17.4 |
| 20 seats | 5.0 | 8.9 | 25.1 |

The AV researcher's figure (proposed_av.json: 10-seat 4.25 / 11.9 / 25.0) uses a similar hourly rate
(≈ S$17/h including a contractor margin) but 30–45 min per vehicle-day, because an unattended
on-demand vehicle needs in-day checks. The values here cover routine daily cleaning; for unattended
operation the lead should use the AV figure or count the in-day checks under field staff.

### 3.5 Onboard customer service officer (`attendant_sgd_per_hour`)

For the third staffing case (remote operator + onboard customer service officer, LTA's stated next
phase for its autonomous public buses; AV researcher). No MOM occupation is an onboard attendant on
an AV; the closest are:

| Occupation (T&S, June 2025) | Gross P25 / median / P75 | Loaded SGD/h (P25 / median / P75 × 1.15) | Register |
|---|---|---|---|
| Rail station service assistant 51121 (frontline, shifts) | 3,251 / 3,588 / 3,949 | 23.8 / 26.3 / 33.1 | G46 |
| Customer service officer/clerk 42245 | 2,400 / 3,146 / 3,933 | 17.7 / 23.2 / 33.4 | G47 |
| Vehicle attendant 93335 | 1,600 / 2,200 / 2,677 | median 16.2 | G47 |

**Proposed `attendant_sgd_per_hour`: low 17.7 (customer service officer P25), central 26.3 (rail
station service assistant median), high 33.4 (customer service officer P75 × 1.15).** Same loading
as §3.2. The central uses the station assistant because it is a public-transport frontline role paid
for shift work (gross/basic 1.17), as an onboard role would be; the literal title "customer service
officer" in T&S includes office roles with little shift pay.

## 4. Electricity (`electricity_sgd_per_kwh`)

All figures before GST. GST is 9 % since 1 Jan 2024 (IRAS, G58); the model excludes it, and a
GST-registered operator recovers input GST.

| Source | 2026 value (SGD/kWh, excl. GST) | Notes | Register |
|---|---|---|---|
| SP Group low-tension tariff, Q4 2026 | 0.2859 | energy 22.18 + network 6.10 + MSS 0.23 + market admin/PSO 0.08 c/kWh; non-domestic = domestic | G53 |
| SP Group low-tension tariff, 2026 quarters | 0.2671 / 0.2727 / 0.3191 / 0.2859, **mean 0.2862** | follows gas prices quarter by quarter | G54 |
| SP Group high-tension small supply, 2026 | off-peak 0.1571, peak 0.2595 (means) + contracted capacity 14.64 $/kW/month | effective 0.217 (overnight, 8 h/night at contracted kW) to 0.360 (daytime peak, 20 % load factor) | G55 |
| EMA USEP, Jan–Aug 2026 | 0.196 (wholesale energy only) | + network ≈ 0.061 + market charges ≈ 0.003 → ≈ 0.26 for a contestable buyer | G56 |
| Public DC fast charging, Sep 2026 (secondary) | 0.69–0.82 | retail incl. charger capital and margin; upper reference only | G57 |
| LTA's own supply contract 2022/2023 | 0.4354 / 0.3616 (unit inferred) | crisis years; not used | G59 |

Arithmetic (HT capacity charge): contracted capacity 14.64 $/kW/month = 1,464 c. Overnight
charging 8 h × 30.4 days = 243 kWh per contracted kW → +6.0 c/kWh; 20 % load factor →
146 kWh/kW → +10.0 c/kWh.

**Proposed `electricity_sgd_per_kwh`: low_cost 0.22 (HT supply, overnight off-peak charging),
central 0.29 (2026 mean low-tension tariff, all-in), high_cost 0.36 (HT supply, daytime peak
charging at low load factor).** Applied to kWh drawn from the grid (after charging losses).

- A large depot (MW of DC chargers) would take an HT supply; with a mixed day/night profile
  (50/50, 40 % load factor) its effective price is ≈ 0.26, so the central 0.29 is slightly cautious.
- Public fast charging (0.69–0.82) is an alternative to owning chargers, not an electricity price;
  it already contains charger capital. Never combine it with `charger_sgd_each`.
- Who pays electricity for LTA's electric buses under the BCM is not stated in any source found.

## 5. Depot and charging site (`depot_sgd_per_vehicle_year`, `depot_fixed_sgd_per_year`, `charger_sgd_each`)

### 5.1 Space per vehicle (assumption, stated separately)

The AV researcher's helper `depot_m2_per_vehicle` (proposed_av.json) is used unchanged: LTA's
parking code minimum lot + half aisle (18.7 / 36 / 57.8 m² for car, rigid < 7.5 m, rigid > 7.5 m),
plus 25 % (central) or 50 % (high) for charging, cleaning and maintenance bays and circulation (G77):

| Seats | low | central | high (m² per vehicle) |
|---|---|---|---|
| 4 | 19 | 24 | 30 |
| 10 | 36 | 45 | 54 |
| 20 | 58 | 72 | 87 |

Cross-check: LTA's multi-storey bus depots use 73 m² of site per bus (Pasir Panjang, ~4 ha for ~550
buses) to 112 m² (Simpang, Yishun, 5.6 ha for ~500) including workshops and workers' quarters.
A fleet of 450 ten-seat vehicles needs about 450 × 45 = 2.0 ha.

### 5.2 Rent per m² (evidence)

| Case | Evidence | SGD per m²-year (2026, excl. GST) | Register |
|---|---|---|---|
| low | Open heavy-vehicle season lot: URA S$130/month (GST-inclusive) per 36 m² rigid-vehicle lot | 130/1.09/36 × 12 = **39.8** | G76 (secondary, undated listing) |
| central | Multiple-user factory, 1st storey: S$2.12 psf/month, Q2 2026 (JTC data); JTC rental index +0.3 % in Q3 2026 | 2.12 × 10.7639 × 12 = **273.8** | G74 (secondary), G75 |
| high | Rent equivalent of an LTA-standard multi-storey bus depot: 696,180 per bus space / 57.8 m² × CRF(3.5 %, 40) | 12,045 × 0.0468 = **564** | G78 (from G17–G19) |

### 5.3 Proposed depot values

`depot_sgd_per_vehicle_year` = m² × rent (space only; chargers, staff and O&M excluded):

| Seats | low_cost | central | high_cost |
|---|---|---|---|
| 4 | 755 | 6,572 | 16,921 |
| 10 | 1,431 | 12,323 | 30,457 |
| 20 | 2,306 | 19,716 | 49,070 |

`depot_fixed_sgd_per_year` (per site; basis assumption with sourced wages):

| Item | low | central | high | Basis |
|---|---|---|---|---|
| 24/7 security | 1 post × 8,760 h × 19.59 = 171,603 | 1 post × 22.90 = 200,561 | 2 posts × 25.67 = 449,692 | MOM OWS security officer 54144 (G79), loaded as §3.2 over 2,100 h |
| Depot manager | 0.5 FTE = 36,524 | 1 FTE = 100,642 | 1 FTE (P75) = 146,132 | MOM OWS transport operations manager 13243, T&S (G80) |
| Facility O&M, non-charging utilities, fire safety, waste, property insurance | 50,000 | 100,000 | 250,000 | assumption (G81) |
| **Total** | **258,000** | **401,000** | **846,000** | |

- A large fleet may need two sites; the fixed cost then doubles.
- Low case = open bus-park style yard; it is plausible only because chargers, cleaning and maintenance
  are costed elsewhere.

### 5.4 Charger cross-check (`charger_sgd_each`, for the AV researcher)

LTA's e-bus depot charging contracts (Nov 2023, G23): S$31.3M (Busways/Shell; Sengkang West and East
Coast depots) and S$14.8M (Presico; Gali Batu). Sengkang West has 240 dual-gun chargers of up to
360 kW (secondary, G24). Charger counts for East Coast and Gali Batu are not public, so only an upper
bound follows: ≤ 31.3M / 240 = **≤ S$130,000 per 360 kW dual-gun charger incl. installation**
(2023), i.e. ≤ S$360 per kW. The AV researcher's central S$80,000 for a ~60 kW depot charger
(≈ S$1,300 per kW, ICCT 2019 basis) is therefore conservative per kW, though small chargers cost
more per kW than 360 kW bus units. No Singapore price for 40–150 kW depot chargers was found.

## 6. Discount rate (`discount_rate_real`)

No Singapore MOF or LTA appraisal guidance with a published social discount rate was found.

| Source | Real rate | Type | Register |
|---|---|---|---|
| UK Green Book (Feb 2026): STPR, years 1–30 | 3.5 % (3.0 % yrs 31–75) | official guidance | G60 |
| Independent Green Book review (Freeman & Groom, 30 Jun 2026), not yet HMT policy | 3.0 % (yrs 0–30) | expert review | G61 |
| ADB (2017): minimum EIRR | 9 % (6 % social sector) | development-bank rationing rate | G62 |
| US OMB Circular A-4 | 3 % and 7 % (2003, reinstated 2025); 2 % (2023) | official guidance (2025 status from secondary source) | G63 |
| Singapore households, leasehold vs freehold condo prices (Fesselmeyer, Liu & Salvo 2021, JAE) | ≈ 2.5–4 % for the first 100 years | peer-reviewed estimate | G64 |
| SGS 10-year yield, Oct 2026 (secondary, citing MAS) | 2.3 % nominal ≈ 0.3–0.8 % real | market statistic | G65 |

**Proposed `discount_rate_real`: low_cost 0.02, central 0.035, high_cost 0.07.**

- Central 3.5 %: the best-documented government rate (UK Green Book), and inside the
  Singapore-specific market-implied range (2.5–4 %).
- Low 2 %: Singapore's real government borrowing cost is below 1 %; 2 % adds a small premium and
  equals the 2023 US rate.
- High 7 %: opportunity cost of private capital (OMB 2003). It also brackets a private AV
  operator's real cost of capital. ADB's 9 % is for developing borrowers and is not used.
- The same three rates are used for the bus asset add-on (§2.4).

## 7. Social values (separate from operator cost): `vot_ivt_sgd_per_hour`, `wait_time_weight`

These values price passenger time; they are never added to operator cost. For both, `low_cost`
simply means the **low value** (a low VoT makes time savings worth less).

### 7.1 Singapore evidence

LTA commissioned a national value-of-time study in 2015 (5,000 households, stated choice, mixed
logit; Hess, Murphy, Le & Leong 2017, TRR 2664, G66–G68). It updated LTA's 2008 values ("Update of
Economic Evaluation Parameters", LTA 2009, not public). Recommended values (2015 SGD, cents/min):

| Component | Bus | MRT |
|---|---|---|
| In-vehicle, seated, empty seats | 10.67 | 17.39 |
| In-vehicle, weighted by crowding conditions | 11.73 | 20.71 |
| In-vehicle, standing, completely packed | 17.01 | 24.50 |
| Waiting time | 15.06 | 17.00 |
| Walking time | 15.96 | 22.83 |
| Interchange (cents per interchange) | 40.82 | 68.16 |
| Excess wait time (unreliability) | 71.74 | – |
| **Equity value, all modes** (weighted by island-wide mode shares) | **27.32 c/min = 16.39 SGD/h** | |

Other Singapore evidence: a revealed-preference smart-card study finds about S$2/h for adult transit
commuters (15–16 % of the wage; Agarwal et al. 2020, JUE, G71) — far below the stated-choice values
and international norms, reported only as an outlier. MRT riders' standing multiplier is 1.18–1.24
at peak crowding (Tirachini et al. 2016, G73); crowding is not modelled in Phase 2.

### 7.2 `vot_ivt_sgd_per_hour`

| Case | Basis | Arithmetic | SGD/h (2026) |
|---|---|---|---|
| low | Bus users' own value (crowding-weighted in-vehicle time) | 11.73 c/min × 60 = 7.04 (2015) × 1.2044 | **8.5** |
| central | LTA equity value of travel time | 16.39 (2015) × 1.2044 | **19.7** |
| high | Equity value uplifted for income growth (elasticity 1) | 16.39 × 5,775/3,949 (median income 2015→2025, MOM) × 1.0151 | **24.3** |

- Central uses the equity value because Phase 2 is a social comparison of a public service; using
  mode-specific behavioural values would value bus riders' time less because they are poorer and
  would change value when a rider switches mode.
- Cross-check: the 2025 median hourly income from work (incl. employer CPF) is about 29.5 SGD
  (5,775 × 12 / (45 h × 52.14), G72); the central value is 0.67 of it, the low 0.29 and the high 0.82
  (ADB 2017 values leisure time as "a proportion of the hourly wage" without fixing the proportion).
- Limits: 2015 survey; values are brought to 2026 with CPI only (study convention), except in the
  high case. Riders here make short trips (median 1.06 km); values for small time savings may be
  lower.

### 7.3 `wait_time_weight`

| Source | Wait / in-vehicle | Register |
|---|---|---|
| LTA study 2015, bus users | 15.06/11.73 = 1.28; vs seated-empty 1.41 (MRT 0.82) | G68 |
| Wardman et al. (2026), worldwide meta-analysis | 1.50 (SP emphasis) – 1.75 (RP emphasis), down from 2 | G69 |
| UK TAG M3.2 (2024) | 1.5–2.5 | G70 |

**Proposed: low 1.3 (Singapore bus SP), central 1.5 (meta-analysis, SP emphasis; consistent with
Singapore), high 2.0 (long-standing convention, TAG mid-range).**

- The weight applies to the model's mean wait (κ/Σf). Unreliability is valued separately and far
  more highly in Singapore (excess wait 71.74 c/min = 6.1 × bus in-vehicle time, G68); it is not used
  because the model does not separate excess wait.
- Widespread real-time arrival information lowers both waits and their disutility (Phase 1 has a
  sensitivity case for app users).

## 8. Conversion factors (CPI and exchange rates)

Register rows G201–G272 (`cpi_<year>`, `fx_<cur>_<year>`).

**Singapore CPI, all items (2024 = 100), SingStat Table Builder M213801 (annual) and M213751
(monthly).** 2026 = mean of Jan–Aug 2026 (latest month Aug 2026 = 103.334).

| Year | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 YTD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CPI | 85.046 | 84.596 | 85.084 | 85.457 | 85.942 | 85.794 | 87.781 | 93.163 | 97.666 | 100.000 | 100.903 | 102.426 |
| Factor to 2026 | 1.2044 | 1.2108 | 1.2038 | 1.1986 | 1.1918 | 1.1939 | 1.1668 | 1.0994 | 1.0487 | 1.0243 | 1.0151 | 1.0000 |

**MAS annual-average exchange rates, SGD per unit of foreign currency (JPY: per 100 yen).** Source:
MAS, via SingStat Table Builder M700851 (annual) and M700051 (monthly; 2026 = mean of Jan–Sep 2026).

| Year | USD | EUR | CNY | JPY (per 100) | GBP |
|---|---|---|---|---|---|
| 2015 | 1.3748 | 1.5267 | 0.2187 | 1.1364 | 2.1023 |
| 2016 | 1.3815 | 1.5286 | 0.2080 | 1.2727 | 1.8726 |
| 2017 | 1.3807 | 1.5589 | 0.2043 | 1.2313 | 1.7782 |
| 2018 | 1.3491 | 1.5931 | 0.2040 | 1.2214 | 1.8008 |
| 2019 | 1.3642 | 1.5272 | 0.1975 | 1.2519 | 1.7415 |
| 2020 | 1.3792 | 1.5744 | 0.2000 | 1.2922 | 1.7697 |
| 2021 | 1.3440 | 1.5890 | 0.2084 | 1.2237 | 1.8484 |
| 2022 | 1.3789 | 1.4514 | 0.2050 | 1.0538 | 1.7032 |
| 2023 | 1.3431 | 1.4523 | 0.1897 | 0.9573 | 1.6701 |
| 2024 | 1.3360 | 1.4457 | 0.1856 | 0.8831 | 1.7078 |
| 2025 | 1.3066 | 1.4765 | 0.1818 | 0.8739 | 1.7227 |
| 2026 YTD | 1.2787 | 1.4851 | 0.1874 | 0.8068 | 1.7196 |

Worked example: USD 100,000 priced in 2021 → × 1.3440 = SGD 134,400 (2021) → × 1.1668 =
SGD 156,818 (2026).

## 9. LTA bus service standards (feeder headways, loading)

| Standard | Value | Status | Register |
|---|---|---|---|
| BCM: basic bus services, scheduled headway in AM/PM peaks | ≤ 15 min; at least half ≤ 10 min | current (MOT, 9 May 2022) | G82 |
| BCM: feeder services, scheduled headway in peak periods | **≤ 8 min** | current (MOT, 9 May 2022) | G82 |
| Off-peak headway | not published | gap | – |
| Loading (crowding) | not published under the BCM; legacy PTC standard: peak loading ≤ 95 % | legacy, obsolete since Sep 2016 | G83 (secondary) |
| Legacy PTC headways | ≥ 90 % of feeders ≤ 10 min weekday peak; ≥ 85 % of services ≤ 20 min off-peak; all ≤ 30 min; first bus by 06:00 | obsolete under BCM | G83 (secondary) |
| Reliability | Excess Wait Time targets with incentives/penalties per 0.1 min (BSRF, from 2014; in BCM contracts) | current | G84 |
| PTC operating standards | ≥ 96 % of scheduled mileage operated; < 0.75 accidents per 100,000 bus-km | current | G83 (secondary) |

Room for a feeder frequency reduction (published AM-peak headway bands, DataMall Oct 2026, G85):

| Service | 800 | 805 | 803 | 801 | 812 | 804 | 811 | 806 | 807 |
|---|---|---|---|---|---|---|---|---|---|
| AM-peak band (min) | 6–10 | 6–10 | 6–8 | 5–8 | 5–8 | 5–7 | 4–6 | 3–4 | 3–8 |

**Conclusion for Option C.** The only published, binding standard is the 8-minute peak headway for
feeders. 800 and 805 already run at it (band midpoint 8 min); the others could be thinned only up to
8 min, and only where peak loads allow, but no loading standard or load profile is public. No
off-peak headway standard is published, so an off-peak reduction would rest on LTA's internal
planning rules. **There is no published basis for evaluating a feeder frequency reduction; the
definitions' default ("not evaluated") stands.** Any reduction would also have to keep the Excess
Wait Time performance that operators are paid on.

## 10. Gaps, assumptions and access problems

### 10.1 Values that rest on assumptions

| Parameter | Assumption | Effect |
|---|---|---|
| `bus_sgd_per_bus_km` | 350 equivalent weekdays per year (335–365); bus-km per package derived from published headways; 60/40 SD/DD price blend; depot life 40 yrs; Seletar fleet 450 (high case only) | ±4 % (days); the denominator is not an operator statistic |
| staff rates, attendant | bonus 1 month; on-costs 5 %; 4 sick days taken; supervision factor 1.15 (high case only) | ±5–10 % each |
| `cleaning_sgd_per_vehicle_day` | minutes per vehicle-day and consumables | dominant; no source |
| `depot_sgd_per_vehicle_year` | m² per vehicle (AV researcher's helper, +25 %/+50 % over the parking code) | proportional |
| `depot_fixed_sgd_per_year` | number of security posts, manager FTE, O&M budget | basis assumption |
| `electricity_sgd_per_kwh` | charging profile and load factor for the HT cases | ±25 % |

### 10.2 Evidence still needed

1. **Bus-km and bus-hours per package from LTA or operators.** The per-km fee rests on a derived
   denominator; package bus-hours would allow a genuine per-hour rate.
2. **Indexed BCM payments actually made** (bid prices exclude inflation, wage and fuel indexation)
   and the **service-variation rates** LTA pays when bus-km change; these decide how much of the fee
   is avoidable in B(ii).
3. **The level of the "lease charges for LTA-provided assets"** inside BCM prices (possible double
   count with the asset add-on) and **who pays electricity for LTA's e-buses**.
4. **Seletar package fleet size** (LTA does not state it).
5. **Weekend service levels** (DataMall headways have no weekend split).
6. **An AV remote-operator wage** (no MOM occupation) and the cost of foreign safety operators (no
   CPF; foreign worker levy).
7. **JTC median rents by property type** (the primary JTC report was not retrievable; a secondary
   report was used) and current URA/HDB heavy-vehicle season parking rates.
8. **A published Singapore social discount rate** (MOF/LTA) and an LTA statement of which values
   from the 2015 value-of-time study it uses in appraisal (equity or mode-specific).
9. **Current BCM off-peak headway and loading standards**, and load profiles for the Yishun feeders.
10. **Singapore prices for 40–150 kW depot chargers**, and charger counts for LTA's East Coast and
    Gali Batu contracts.

### 10.3 Could not access

- ComfortDelGro Annual Report 2025 (SGX download failed with a proxy error) and SBS Transit's full
  financial statements after 2017 (only operations reviews are posted), so no operator cost per km.
- US DOT and FAA value-of-time guidance (HTTP 403); ScienceDirect, SSRN and ResearchGate pages for
  Agarwal et al. (2020) (HTTP 403; values quoted from the published abstract via the search index).
- MAS SGS benchmark-yield page (form-based; yields taken from a secondary source citing MAS).
- SP Group's Q4 2026 media release (HTTP 404; the tariff page and SP's historical tariff workbook
  were used instead); HDB's commercial-vehicle season-parking page (HTTP 404).
- MOM's OWS 2025 Tables 1–3 (bot protection); Tables 4, 4.4 and 5 and the methodology were
  retrieved.
- LTA's 2009 "Update of Economic Evaluation Parameters" (cited by Hess et al. 2017; not public).

### 10.4 Conflicts noted

- Bus fee per km differs by package (4.6–6.0 in 2026 prices): resolved by using the Seletar package,
  which runs the Yishun feeders, as central.
- VoT: LTA's stated-choice study (bus 8.5, equity 19.7 SGD/h, 2026 prices) vs a revealed-preference
  smart-card study (~2.4 SGD/h): resolved in favour of the LTA-commissioned stated-choice values;
  the RP value is an outlier for small within-network time differences.
- Wait weight: Singapore bus SP 1.28–1.41 vs the long-standing 2.0: resolved with the 2026 meta-analysis
  (1.5), which matches Singapore closely.
- Cleaning: this file 6.3 vs AV researcher 11.9 SGD per 10-seat vehicle-day; the difference is the
  in-day checking time of an unattended vehicle, not the wage (see `cleaning_sgd_per_vehicle_day` note).
