# Driverless Yishun, Phase 2: what would a combined bus and shuttle service cost, and whose time would it save?

**Question.** Can a combined bus and autonomous shuttle service save passenger time at an acceptable
additional operating cost?

Every number below comes from `data/processed/phase2/summary.json` and the generated tables in
[`results.md`](results.md) (section numbers in brackets, e.g. [§3]). Costs are SGD per average
weekday at 2026 prices, excluding GST, rounded to two significant figures; passenger time is stop
to stop (waiting plus riding, no walking).

*This version follows an [independent review](review.md) that found nine problems, three of them
material. The bus model has been corrected and every simulation re-run; several conclusions of the
first version changed, and the section "Changes after the independent review" at the end lists
them.*

## Answer in brief

- **Shuttles can save passenger time, but no option tested lowers operating cost.** Every
  configuration with acceptable service costs more to run than today's buses alone [§3]. Whether
  the extra cost is acceptable is a budget choice; the study shows what each budget buys rather
  than one "acceptable" figure.
- **With someone on board, every design buys an hour of riders' time for about SGD 33–43.** With
  a safety operator on board, which the current pilots require, the four C reference designs save
  1,609–10,111 passenger-hours a weekday (5–32 % of today's 32,056) for SGD 56,000–370,000 more a
  day (central case): SGD 33–36 per passenger-hour saved. Full replacement with 450 ten-seat
  shuttles and every bus kept saves 13,943 hours for SGD 600,000 a day, SGD 43 an hour [§1, §3].
- **C is cheaper per hour than full replacement only while every bus is kept.** If the 15 services
  that carry only internal riders were withdrawn, full replacement would cost SGD 36 an hour at
  the full bus cost and SGD 37 counting the bus operator's fee only: level with C [§3].
- **Narrower targeting does not buy time more cheaply.** From θ = 6 to 14 minutes the C designs cost
  SGD 33–36 per hour saved: smaller designs buy fewer hours at about the same price [§3].
- **Staffing moves the cost the most among cost inputs; the bus model moves the saving more.**
  Remote supervision with nobody on board, not permitted on Singapore's public roads today, cuts
  C to SGD 20–21 per hour saved, about 40 % less. In that case full replacement becomes the
  cheaper way to buy time: SGD 17 with 700 four-seat vehicles (a weakly evidenced price that
  excludes COE), or SGD 17–19 with the internal-only services withdrawn [§3, §13]. Remote
  supervision with an attendant on board, LTA's stated next phase, costs about the same as a
  safety operator. On the time side, if the modelled bus times of the rides the shuttles carry
  were 20 % too high, C's saving would fall by 37–42 % [§9].
- **Against a value of time, the savings fall short of the cost with someone on board.** At the
  central value of in-vehicle time (SGD 19.7 an hour, waiting weighted 1.5) the time saved is
  worth SGD 0.61–0.66 for each SGD 1 of added cost with an operator or attendant on board, and
  SGD 1.01–1.11 with remote supervision only. Even at the high value of time no design reaches
  SGD 1 with someone on board. This is a separate social estimate: time savings are not operator
  revenue [§11].
- **Full replacement fails at the kerb under either decline rule; C does not.** As first defined,
  B lets riders wait up to 45 minutes with no bus to fall back on, and loses time against today's
  buses when 15 % of its fleet is unavailable. Under C's rule (decline after 15 minutes, take the
  bus) the same 450 shuttles keep a saving of 10,393 hours in that stress. With at most 10 or 7
  shuttles boarding at once per station (test values; the real capacity is unknown), full
  replacement loses time under either rule, while the C designs keep 78–100 % of their saving
  [§8].

**Which options merit further study:** C designs at θ 8–14 minutes (40–175 ten-seat shuttles,
50–220 vehicles with reserves) as a trial design, under each staffing arrangement. They do not buy
time more cheaply than larger designs, but they commit the least money and the fewest vehicles,
keep every bus, and are untroubled by kerb limits. Full replacement is not a near-term option:
it needs 450 shuttles in service (561 with reserves) against 152 buses in the area at 07:00,
drives 4.7 times their kilometres, matches C's price per hour only by withdrawing bus services,
and loses time at kerb limits. It remains the upper bound on the time shuttles could save.

## Options compared

| | Option | What runs | Bus service |
|---|---|---|---|
| **A** | Current bus | Today's routes and published headways (Phase 1 bus model) | As today |
| **B** | Full shuttle replacement | A fixed fleet of pooled shuttles carries every internal ride (Phase 1's definition) | (i) all buses kept; or (ii) a theoretical bound: the 15 services that carry only internal riders withdrawn |
| **C** | Combined bus + shuttle | Shuttles carry the rides that today's timetable serves worst; every other ride stays on the bus | All buses kept |

B is a theoretical replacement scenario, not a bus withdrawal plan. Its bus case (ii) shows the most
bus cost a full replacement could avoid.

**Option C's rule ("timetable gap").** A ride from stop *o* to stop *d* requested at minute *t* is
offered a shuttle when the bus is expected to be slow for it.
- The test: the expected bus stop-to-stop time exceeds a direct drive between the two stops, plus
  the shuttle's two stops, by at least θ minutes.
- The expected bus time is built from LTA's published routes, headways and first and last buses.
  Everything the rule uses is known before the passenger travels, so eligibility is a fixed table
  of stop pairs by time of day.
- The rule never uses the wait a passenger happens to get on the day. A test checks that tripling
  the simulated bus waits leaves the set of offered rides unchanged (`tests/test_phase2.py`).
- Repositioning uses the expected offered demand from the same table.
- A shuttle request is declined if the best quoted pickup is more than 15 minutes away. The rider
  then takes the bus at today's time (treatment R1; R2 and R3 are tested, §5 below).
- θ sets the coverage. The search ran from 4 to 16 minutes. The four reference designs are θ = 6,
  8, 10 and 14 minutes, each at its service-level fleet.

**Fleet sizes are set by a service standard, not by cost.**
- C: the smallest simulated fleet with at most 1 % of offered rides declined in every hour of every
  simulated day, with every larger simulated fleet also passing [§12].
- B: no rider refused in any hour (Phase 1's parity fleet: 450 ten-seat shuttles).
- Only configurations meeting their standard enter the trade-off frontier and the budget tables.
  Undersized fleets are shown, marked as not acceptable, and never counted as cheap savings.

**Variants.**
- 4- and 20-seat vehicles.
- A 45-minute decline limit.
- Shuttles only after 20:00, when headways are longest, either for every ride or with θ = 8.
- B with a 10 % fleet margin (500 vehicles) in the stress tests.
- In the stress tests, B also runs under C's rule: 450 shuttles offered every ride, a request
  declined beyond 15 minutes and the rider taking the bus. B as defined accepts quoted pickups up
  to 45 minutes and refuses beyond that with no bus to fall back on, so this variant separates
  that design choice from full replacement itself (review R3).

## What is observed, simulated and assumed

| Status | What |
|---|---|
| **Observed** | Internal bus rides by stop pair and hour (LTA fare-card origin–destination counts, July–August 2026); all Singapore bus rides, used to share Yishun's bus-km between internal and other riders; LTA routes, headway bands, first and last buses (pinned copies, 23 Oct 2026); the road network (OpenStreetMap, pinned 22 Oct 2026) |
| **Calibrated** | Road speeds, signal delay, bus dwell and headway regularity, fitted to LTA's live arrival estimates (Phase 1) and checked against bus GPS movement; headways before 06:30, which LTA does not publish, are assumed |
| **Simulated** | Shuttle waits, rides, declines and refusals; vehicle-km, empty km, vehicle-hours and kerb use (Phase 1's event-driven simulator, unchanged), on Poisson demand days around the observed average weekday (three per configuration; ten for A and the references) |
| **Modelled** | Bus waits and in-vehicle times (common-lines model on published headways; a rider boards a looping line at whichever visit of the stop gives the shortest ride); bus-km and bus-hours inside Yishun |
| **Evidence, with ranges** | Costs: vehicle price, life, energy, maintenance, cleaning, insurance, software, wages, chargers and depot, bus cost per bus-km; the social values of time. Each has a low, central and high value in `data/parameters/cost_cases.json`, with sources in `cost_register.csv` |
| **Assumed** | Values with no usable evidence, labelled as assumptions in the register (staffing ratios, insurance, software, permits, the control centre); the availability estimate (charging and maintenance reserves, an energy balance and not a charging simulation); demand fixed at today's rides; no congestion feedback; no relief staff; no rider timing their arrival with live bus information |

The register has 247 rows behind 36 parameters. A contract value enters a category only after its
inclusions are checked, so a bundled contract is never used as a vehicle price. Vehicles are either
bought (an annuity) or leased, never both.

## Results

### 1. Passenger time

![Passenger-hours by option](img/passenger_time.png)

| Option | Rides by shuttle | Passenger-hours saved per weekday (range over 10 simulated days) | Share of A | Mean / 90th percentile, min |
|---|---:|---:|---:|---:|
| A: today's buses | — | — | — | 11.8 / 19.7 |
| B: 450 × 10-seat | 100 % | 13,943 (13,327–14,137) | 43 % | 6.7 / 10.6 |
| C: θ 6 min, 275 | 49 % | 10,111 (10,062–10,149) | 32 % | 8.1 / 12.0 |
| C: θ 8 min, 175 | 28 % | 6,729 (6,659–6,796) | 21 % | 9.3 / 14.1 |
| C: θ 10 min, 100 | 15 % | 4,064 (4,011–4,110) | 13 % | 10.3 / 15.9 |
| C: θ 14 min, 40 | 4 % | 1,609 (1,574–1,652) | 5 % | 11.2 / 18.1 |

- The same 163,069 rides are compared in every option. These are the mean over ten simulated
  days of the internal rides with a bus option; 0.4 % have none and are excluded everywhere.
- Today's buses take 32,056 passenger-hours a weekday, 8,920 of them waiting [§1].
- The reference designs decline fewer than two rides a day on average (C θ 10: one or two on some
  days) and no reference refuses any [§1, §4].
- The ranges are random variation between simulated days, nothing more. They are not a
  confidence interval for real-world performance.

### 2. Operating cost

![Cost by class](img/cost_classes.png)

Additional cost per weekday against Option A, with all buses kept unless stated [§3]:

| | Safety operator on board | Remote + attendant | Remote only |
|---|---:|---:|---:|
| B: 450 × 10-seat | SGD 600,000 (300,000–1,200,000) | SGD 590,000 | SGD 340,000 (120,000–940,000) |
| B (ii): internal-only services withdrawn, full bus cost avoided | SGD 500,000 | SGD 490,000 | SGD 240,000 |
| B (ii): the same, operator fee only avoided | SGD 520,000 | SGD 510,000 | SGD 260,000 |
| C: θ 6 min, 275 | SGD 370,000 (190,000–760,000) | SGD 360,000 | SGD 210,000 |
| C: θ 8 min, 175 | SGD 240,000 (120,000–490,000) | SGD 230,000 | SGD 140,000 |
| C: θ 10 min, 100 | SGD 140,000 (69,000–280,000) | SGD 130,000 | SGD 80,000 |
| C: θ 14 min, 40 | SGD 56,000 (28,000–120,000) | SGD 55,000 | SGD 34,000 |
| **Per passenger-hour saved: B** | **SGD 43** (22–89) | SGD 42 | **SGD 25** (8.6–67) |
| **Per passenger-hour saved: B (ii)**, full bus cost / operator fee only | SGD 36 / 37 | SGD 35 / 37 | SGD 17 / 19 |
| **Per passenger-hour saved: C** | **SGD 33–36** | SGD 33–36 | **SGD 20–21** |

- **Cost structure.** With someone on board, staff are 45–49 % of the shuttle cost, fixed costs
  (vehicles, depot, software, insurance) 43–47 % and distance costs 8–9 %. With remote supervision
  only, fixed costs are three-quarters [§3].
- **Unit costs.** A C shuttle ride costs SGD 4.6–8.0 with an operator on board and SGD 2.7–4.9
  remote only. B's ride costs SGD 3.7 and 2.1 [§3].
- **Fleet.** The total fleet includes estimated charging and maintenance reserves, an estimate
  and not a charging simulation. B needs 561 vehicles for 450 in service, and C θ 8 needs 220 for
  175 [§2].
- **Today's buses, for context [§10].**
  - All bus services inside Yishun cost about SGD 220,000 a weekday (180,000–300,000).
  - Internal riders account for 53.4 % of their passenger-km, so SGD 120,000 is allocated to
    them, or SGD 0.73 per internal ride. All buses are kept in A and C, so this cost cancels in
    every comparison.
  - The 15 services that carry only internal riders cost SGD 100,000 a weekday at the full
    resource cost per bus-km (81,000–140,000), or SGD 80,000 at the operator fee only. The full
    cost adds LTA's bus and depot capital to the operator fee, which itself includes a lease charge
    for LTA's assets, so the full cost may count those assets twice; both are shown. This is the
    most a full replacement could avoid (B ii).
  - No feeder frequency reduction is assumed in C. The only published standard, an 8-minute
    peak headway for feeders, is already met by services 800 and 805, and no load profiles are
    public (`sources_sg.md` §9).

**Every configuration with acceptable service increases cost and reduces passenger time** (62 of 62
in each staffing case, central costs). None reduces cost; none increases both. Refused and
declined rides are counted in every total, so no option looks faster by serving fewer people.

### 3. Trade-off: what each budget buys

![Trade-off](img/tradeoff.png)

![Frontier by staffing case](img/tradeoff_staffing.png)

- The frontier is the set of configurations that save more than every cheaper one. In the
  central case it is made of C designs up to about SGD 530,000 a day with someone on board, and up
  to about SGD 270,000 with remote supervision only. Above that, B fleets save more for the extra
  money.
- Along the frontier the price of an hour saved barely changes with the size of the C design;
  what changes is how many hours a budget buys.
- In the remote-only case, a fleet of 700 four-seat B vehicles costs SGD 17 per hour saved,
  less than any C design (SGD 20–21). The 4-seat price rests on weak evidence (central
  SGD 150,000) and excludes COE and registration taxes, which could be large for this class.

![Budget curve](img/budget.png)

With a safety operator on board, central case, the most passenger-hours saved within a daily
budget [§6]:

| Budget per weekday | Best configuration | Passenger-hours saved | Per hour saved |
|---:|---|---:|---:|
| SGD 30,000 | none fits | — | — |
| SGD 50,000 | C θ 16, 30 shuttles | 1,053 | SGD 41 |
| SGD 100,000 | C θ 12, 60 | 2,460 | SGD 34 |
| SGD 150,000 | C θ 10, 150 four-seat | 4,614 | SGD 32 |
| SGD 300,000 | C θ 8, 200 | 7,258 | SGD 37 |
| SGD 400,000 | C θ 5, 300 | 10,882 | SGD 37 |
| SGD 600,000 | B 450 | 13,943 | SGD 43 |
| SGD 800,000 | B 700 four-seat | 15,628 | SGD 42 |

- In the low-cost case the same SGD 100,000 buys 4,938 hours; in the high-cost case, 1,053 hours
  [§6].
- With remote supervision only (central), SGD 50,000 buys 2,460 hours and SGD 150,000 buys 6,729.

### 4. Who gains, who loses and who pays

![Savings by period](img/periods.png)

**Who gains: riders whose bus trip is slow compared with a direct drive.** These are the looping
feeders and the long headways early and late in the day.
- For C at θ 8 min, the saving is 22 % of A's passenger-hours in 05:00–06:59, 13 % in the morning
  peak, 23 % off-peak, 19 % in the evening peak and 27 % after 20:00 [§5]. B shows the same
  pattern at a higher level (47, 25, 49, 39 and 53 %).
- Rides to and from the MRT stations and the interchange gain about as much as estate rides
  (21 % against 20 % of their passenger-hours at θ 8) [§5].

**Who loses: very few riders under C.**
- Comparing each ride with the same ride by bus, using one simulated bus wait per ride, 0.0–2.6 %
  of rides in any period arrive later under the C designs.
- Rides that stay on the bus are unchanged, and declined riders keep today's bus time (R1).
- Under B, 8 % of all rides arrive later than by bus, and 23.6 % in the morning peak [§5].

**Who pays.** The added operating cost falls on whoever funds the service (SGD 34,000–370,000 a
weekday for the C reference designs, by staffing).
- Bus riders from outside Yishun (47 % of in-area bus passenger-km) are unaffected by C, because
  every bus is kept.
- C also takes riders off buses. Any relief of crowded buses is not counted, because bus crowding
  is not modelled.

### 5. Declined and refused rides

- The C reference designs decline fewer than two rides a day on average in the base case, and no
  reference refuses any [§4]. The treatment choice (R1, R2 or R3) therefore does not change any
  base-case result.
- It matters under stress. With 15 % of the fleet unavailable, C θ 6 declines 1,221 rides a day.
  Its saving is 8,321 hours if they take the bus (R1), 7,608 if each counts 45 minutes plus a
  direct ride (R2), and 8,219 with a 5-minute penalty (R3) [§8].
- B's refusals always count at 45 minutes plus a direct ride, a lower bound on their time.
- A 45-minute decline limit lets C meet the service standard with at least 9–25 % fewer shuttles
  at the same coverage (the smallest fleets simulated pass) [§12]. The cost per hour saved does
  not fall: at θ 8 min, 150 shuttles save 5,233 hours (SGD 39 an hour with an operator on board)
  instead of 175 saving 6,729 (SGD 35), because more riders wait long [§13].

### 6. What controls the conclusion

![Cost swings](img/tornado.png)

**The bus model, on the time side.** C selects rides by their modelled bus time, so an
overstatement there is selected for.
- If the modelled bus times of the rides the shuttles carry were 10, 20 or 30 % too high, C θ 8's
  saving would fall by 21, 42 or 63 % (B: 23, 46, 69 %); across the C designs a 20 % overstatement
  removes 37–42 % [§9]. The cost per hour saved would rise by 1 ÷ (1 − loss): by 27, 72 and
  169 % for C θ 8.
- The review found one such error, on the figure-of-eight feeder 812; correcting it removed 5–25 %
  of the C designs' savings (see the end of this report).
- In Phase 1, observed bus GPS movement took 0.99 times the modelled time at midday and 1.02
  times in the evening peak. That check covers bus running times across the network, not the
  feeder-loop pairs C selects, nor their waits. Checking those pairs is the most important missing
  validation.

**Staffing, on the cost side.** This is the structural switch.
- Moving from an operator on board to remote supervision only cuts the cost per hour saved by
  about 40 %.
- The remote cases are scenarios, not forecasts. No Singapore 1:N remote-supervision ratio is
  published, and the central ratio of 10 vehicles per operator comes from WeRide's China
  operation.

**Cost parameters, one at a time** (C θ 8 min, 175 shuttles; central SGD 35 per hour saved with an
operator on board):
- The on-board staff wage moves it from SGD 30 to 42.
- The vehicle price moves it from 30 to 40, and the vehicle life from 32 to 37.
- Remote only (central SGD 20): the vehicle price moves it from SGD 16 to 25, the vehicle life
  from 18 to 23, and vehicles per remote operator from 19 to 24.
- With an attendant on board, the attendant wage moves it from SGD 30 to 39.
- The joint low and high cost cases span roughly half to twice the central cost with someone on
  board, and a third to nearly three times with remote supervision only [§3].

**Thresholds** (central case, C θ 8 min) [§7]:
- *Value-of-time benchmark.* For the cost per hour saved to equal the central value of
  in-vehicle time (SGD 19.7), the added cost would have to be SGD 130,000 a day, against SGD
  240,000 with an operator on board: the on-board wage would have to fall to about nothing
  (SGD 0.06 an hour, central SGD 28). With remote supervision only, the added cost is SGD 140,000, just above the
  benchmark; it is met if each remote operator watches at least 19 vehicles (central 10), if a
  remote operator costs at most SGD 14 an hour (central 28), or if a vehicle costs at most
  SGD 500,000 (central 540,000).
- *Vehicle cost under a budget.* A SGD 150,000 daily budget allows SGD 680 per vehicle-day
  against SGD 1,100 now with an operator on board (SGD 620 remote only).
- *Utilisation.* To cost SGD 4 a ride (Punggol's AV shuttle fare, for context only, not revenue),
  a C shuttle would need 16.9 rides per vehicle-hour with an operator on board; it carries 12.7.
  Remote only, 8.8 suffice. No utilisation in the searched range brings a shuttle ride down to the
  bus's SGD 0.73 per internal ride.

**When C is preferable.**
- C designs are the best use of any daily budget up to the frontier's switch point [§6]. In the
  central case that is about SGD 530,000 a day with someone on board (270,000 in the low-cost
  case, 1.1 million in the high-cost case). With remote supervision only it is about SGD 270,000,
  where 700 four-seat B vehicles take over (65,000–840,000 across the cost cases).
- C is preferable where kerb space at the stations is limited, and where buses must be kept.
- C is not preferable where the aim is the largest possible saving regardless of cost, nor, at the
  same price per hour, where withdrawing bus services is acceptable.

### 7. Stress tests

Passenger-hours saved against Option A in the same conditions, mean of the same three simulated
days in every row [§8]. "B, C's rule" is 450 shuttles offered every ride, declined beyond 15
minutes to the bus.

| Condition | B 450 | B, C's rule | B 500 | C θ 6, 275 | C θ 8, 175 | C θ 10, 100 | C θ 14, 40 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Base case | 14,054 | 14,173 | 15,211 | 10,102 | 6,744 | 4,071 | 1,603 |
| Roads and buses slower | 10,968 | 12,356 | — | 9,097 | 6,231 | 3,746 | 1,523 |
| Evening-peak speeds all day | 14,490 | 15,267 | — | 11,022 | 7,481 | 4,479 | 1,784 |
| Shuttles 25 % slower | 3,235 | 10,483 | — | 7,711 | 5,382 | 3,213 | 1,373 |
| 15 % of the fleet unavailable | −8,566 (1,144 refused) | 10,393 (3,469 declined) | 11,985 | 8,321 (1,221 declined) | 5,769 | 3,488 | 1,489 |
| Kerb: 10 shuttles at once per station | −113,946 (31,382 refused) | −10,870 (20,985 declined) | −127,291 (30,240 refused) | 10,076 | 6,741 | 4,071 | 1,603 |
| Kerb: 7 at once | −171,991 (58,752 refused) | −39,868 (53,006 declined) | — | 7,889 (2,047 declined) | 6,736 | 4,065 | 1,603 |
| Combined: slower roads, 15 % unavailable, kerb 7 | −140,038 (61,272 refused) | −27,030 (51,722 declined) | −154,097 (60,549 refused) | 6,989 (2,463 declined) | 5,074 (722 declined) | 3,126 (405 declined) | 1,387 |

Every decline and refusal is listed in [§8].
- **Most of B's fragility is its decline rule.** As defined, B lets riders wait up to 45 minutes
  and refuses beyond that with no bus. Under C's rule the same fleet keeps 10,393 hours with 15 %
  of its vehicles unavailable and 10,483 with shuttles 25 % slower; a 10 % fleet margin (B 500)
  absorbs the loss of availability too.
- **The kerb limit is not.** At 10 or 7 shuttles at once per station, full replacement loses time
  against today's buses under either rule: the stations are where its demand is, and the
  dispatcher does not anticipate kerb queues, so more vehicles make it worse (B 500 against B 450).
  The limits of 10 and 7 are test values; the real kerb capacity is listed under evidence needed.
- C's shuttles serve a minority of each station's rides. The kerb limits leave θ 8–14 untouched
  and take 22 % of θ 6's saving at 7 per station; the combined stress takes 13–31 %.
- Speed stresses scale road times for buses and shuttles alike. They are not a congestion model:
  added shuttle traffic slows nothing.

### 8. Social estimate (separate from operator cost)

- The valuation is in-vehicle hours saved plus 1.5 × waiting hours saved, at SGD 19.7 an hour.
  That is the central value from an LTA-commissioned 2015 stated-choice study (Hess et al.,
  2017), brought to 2026 prices.
- The time saved is worth SGD 330,000 a weekday for B and SGD 34,000–240,000 for the C designs.
- Value ÷ added cost [§11]:
  - with an operator or attendant on board: 0.55–0.56 (B) and 0.61–0.66 (C);
  - with remote supervision only: 0.96 (B) and 1.01–1.11 (C).
- With low values of time (SGD 8.5, weight 1.3) no case reaches 1. With high values (SGD 24.3,
  weight 2.0) none reaches 1 with someone on board (C 0.81–0.92); remote only, all do.

## Which options merit further study, and under what conditions

1. **C at θ 8–14 min with 40–175 ten-seat shuttles.**
   - It costs SGD 56,000–240,000 a day with an operator on board, for 1,609–6,729 passenger-hours,
     at SGD 33–35 an hour: the same price per hour as larger designs, for the smallest commitment.
   - It needs a fleet of 50–220 vehicles, including reserves. Singapore's whole autonomous
     passenger fleet is 16 vehicles (MOT, Sep 2026; Phase 1).
   - It keeps every bus and is untroubled by the kerb limits tested.
   - It merits a trial design where buses loop or run rarely: early mornings, late evenings and
     the estate pairs the timetable serves worst.
   - Its case strengthens if remote supervision is permitted, and weakens if the bus model
     overstates bus times on the selected pairs.
2. **C at θ 6 min (275 shuttles)** saves more at the same price per hour (SGD 36 on board), with a
   larger fleet and the first sensitivity to kerb limits. It is a second step, not a first.
3. **B** is not a near-term option.
   - It needs 450 shuttles in service (561 with reserves), against 152 buses in the area at 07:00.
   - It drives 159,866 km a day, against 33,871 bus-km.
   - It matches C's price per hour only by withdrawing the internal-only bus services, and loses
     time at kerb limits of 10 or 7 per station under either decline rule.
   - With remote supervision only, a full-replacement fleet would be the cheapest way to buy time
     (SGD 17 an hour with 700 four-seat vehicles). That rests on an arrangement not permitted
     today and a vehicle price without COE.
   - It stays useful as the upper bound of the time shuttles could save.
4. **Evening-only service** is not cost-effective (SGD 94–120 per hour saved on board). A fleet
   used seven hours a day still carries a full day's vehicle cost.
5. **Vehicle size.** 20-seat vehicles cost more per hour saved than 10-seat ones in every case
   [§13]. 4-seat vehicles cost about the same or less in every staffing case: with an operator on
   board, C θ 10 with 150 four-seat vehicles costs SGD 32 per hour saved against SGD 33 for 100
   ten-seat ones; remote only, SGD 13 against 20. That rests on the weakly evidenced 4-seat price
   (central SGD 150,000, range 60,000–270,000) without COE.

## Evidence still needed

1. **Bus times on the pairs C selects.** Validate modelled waits and in-vehicle times on feeder
   loops and early and late headways against GPS or fare-card tap-out times. This is the largest
   time-side uncertainty.
2. **Staffing rules.** The permitted remote-supervision ratio and the conditions for removing the
   on-board operator (`sources_av.md` §12). Punggol's operator, control-room and intervention
   hours.
3. **Singapore vehicle quotations** with software, support and warranty itemised; the
   registration category, COE and tax treatment of AV shuttles, above all for 4-seat vehicles.
4. **Kerb capacity at Yishun, Khatib and the interchange** for shuttle boarding. It decides
   whether full replacement is feasible at all.
5. **Availability.** Uptime, charging and maintenance data from the Punggol and other AV fleets.
   The reserves here are estimates.
6. **Insurance quotes, depot grid-connection costs** and incident rates, now assumptions.
7. **Bus loads by service and hour**, to test any feeder frequency reduction under the 8-minute
   standard.

## Limits

[`limits.md`](limits.md) lists each limit, whom it favours and how it is handled. The most
important:
- no congestion feedback (favours shuttles);
- unlimited kerb space in the base case (favours shuttles, most of all B);
- a fixed fleet all day (raises shuttle cost);
- demand fixed at today's rides;
- bus crowding not modelled (C's relief of buses is not counted);
- no rider times their arrival with live bus information; the reviewer estimates savings would
  fall by about a fifth if only bus riders did;
- no relief or spare staff (a 10–15 % relief factor would add about 4–7 % to on-board costs);
- charging as an energy-balance estimate;
- vehicle prices without COE and registration taxes;
- remote cases that are not permitted today.

## Reproduce

```bash
make data                  # inputs, including the pinned OpenStreetMap extract and LTA bus files
make phase2-allocation     # who uses Yishun's bus-km (needs the July + August 2026 full OD files)
make phase2-experiments    # coarse, refine, capacity, wmax, window, stress, replicates (about 1.5 h on 4 cores)
make phase2-results        # summary.json, page data, these charts and results.md
make test                  # includes the output-consistency checks
make web && make serve     # the study page, Part 2 at /study.html#phase2
```

- Every grid records its commit, input digests, model key and whether tracked pipeline files were
  modified (`data/processed/phase2/<grid>/config.json`). The summary repeats these per grid, with
  the cost file's digest [results.md, top].
- The final runs all came from commit `42ff8b4` with a clean tree and model key `0cd6fcca7d4d`.
- LTA's bus stops, services and routes (`data/processed/lta/`) and the OpenStreetMap extract
  (`data/processed/osm/`) are committed with SHA-256 checksums and restored by `make data`, so a
  rebuild uses the same inputs after LTA's next timetable change.
- `tests/test_phase2_outputs.py` recomputes the headline savings from the run files. It also
  checks that the page data and `results.md` equal a fresh build from the summary.

**Files.**
- Code: `pipeline/yishun/costs.py`, `pipeline/yishun/phase2/`.
- Parameters and sources: `data/parameters/cost_cases.json`, `data/parameters/cost_register.csv`,
  [`sources_av.md`](sources_av.md), [`sources_sg.md`](sources_sg.md).
- Raw runs: `data/processed/phase2/<grid>/runs.parquet`, `hourly.parquet`, `groups.parquet`.
- Summary: `data/processed/phase2/summary.json`. Tables: [`results.md`](results.md). Charts:
  `img/`.
- Definitions: [`definitions.md`](definitions.md). Audit of the Phase 1 baseline:
  [`audit.md`](audit.md). Independent review: [`review.md`](review.md).

## Changes after the independent review

The [review](review.md) of the first version (results from commit `6e0c8ab`) found nine problems.
What was done, and what it changed:

| Finding | Done | Effect on the results |
|---|---|---|
| R1 · material: riders boarded a looping line at the stop's first visit; on figure-of-eight feeder 812 a rider for the second loop was timed riding the first loop too | Riders board at whichever visit gives the shortest ride (`busnet.BusBaseline.ride`, `bus_allocation.shortest_rides`), tested against brute force on every real line that revisits a stop; the model key changed and every grid was re-run | Today's buses: 32,559 → 32,056 passenger-hours. Savings fell by 3.5 % for B and 5–25 % for the C designs (θ 14: 2,151 → 1,609 hours). C's cost per hour saved rose from SGD 26–35 to 33–36 on board, and the fall in cost per hour with narrower targeting disappeared. The service-level fleets did not change |
| R2 · material: "C buys time more cheaply than any full replacement" holds only with all buses kept | Claim qualified; B (ii)'s cost per hour saved reported | With the internal-only services withdrawn, B and C cost the same per hour (SGD 36–37 against 33–36 on board); remote only, B (ii) and the 4-seat B fleet are cheaper than C |
| R3 · material: the stress tests compared B and C under different decline rules | B re-run under C's rule in every stress; the base row uses the same three days | B's losses under fleet and speed stresses came from its rule; its losses at kerb limits did not |
| R4: no rider times their arrival with live bus information | Stated in the limits | Not re-run |
| R5: no relief staff; unlimited kerb in the base case | Stated in the limits | Not re-run |
| R6: the full bus cost may count LTA's assets twice | B (ii) reported at the full cost and at the operator fee only | B (ii) costs SGD 1–2 more per hour saved at the fee-only rate |
| R7: LTA's static bus files were not pinned | Committed with checksums; `make data` restores them | None: the files used were identical |
| R8: report statements stronger than the outputs, one wrong (4-seat vehicles) | This report rewritten from the re-run | — |
| R9: defects in generated tables and charts | Fixed in `report_tables.py` and `charts.py` | — |

The value of the time saved per SGD 1 of added cost fell from 0.67–0.80 to 0.61–0.66 for C with
someone on board, and from 1.15–1.31 to 1.01–1.11 with remote supervision only. With high values
of time, the smallest C design no longer reaches 1 with someone on board.
