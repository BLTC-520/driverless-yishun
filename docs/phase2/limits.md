# Phase 2: structural limits and how each is handled

*Working list, kept with the code. Each limit is either tested, bounded or stated in the report.
"Favours" says which option the limit flatters.*

| Limit | Favours | Treatment |
|---|---|---|
| Fixed shuttle fleet in service all day (no hourly resizing); staff and vehicle-hours sized for it | buses (raises shuttle cost) | Stated. Phase 1's hour-window lower bounds show off-peak needs fewer vehicles |
| Charging is an availability estimate (energy balance), not a charging simulation | uncertain | Low-cost case absorbs charging in off-peak idle time; central and high spread it over the day |
| No congestion feedback: added shuttle-km do not slow roads, buses or each other | shuttles | Speed stresses (slower roads; shuttles 25 % slower) bound it; it is not a congestion model |
| Demand fixed: no riders attracted by faster trips, no fare effects (Punggol's AV fare is $4) | uncertain | Stated. Passenger time is valued only in a separate social analysis, never as revenue |
| Bus crowding and denied boarding not modelled; C takes riders off buses | buses | Stated. C's relief of crowded buses is not counted |
| Bus in-vehicle time on feeder loops is modelled. C targets exactly the pairs where it is long, so model error there is selected for | C | Bus-error sensitivity: saving recomputed with the bus model overstating bus time of the carried rides by 10–30 % |
| Headways before 06:30 are not published; the late-evening band is assumed (Phase 1) | C in 05:00–06:59 | Savings reported by period; the early period is flagged |
| Rides are stages, not trips: two-bus trips inside Yishun stay two requests | buses | Stated. A shuttle could merge them; not counted |
| Shuttle stop time 20 s + 4 s per rider (assumed) | uncertain | Phase 1 sensitivity: 15 s and 40 s move the B fleet by one grid step |
| Dispatcher: immediate insertion, exact travel times | buses (a better dispatcher needs fewer vehicles) | Phase 1: wider searches lower the B fleet from 450 to 375–400 |
| C declines a request whose quoted pickup is more than 15 min away; the rider takes the bus and loses no time (R1) | C | R2 (45 min + direct ride) and R3 (+5 min) treatments; a 45-min decline limit |
| No rider times their arrival with live bus information: bus waits assume random arrival at every headway (κ = 0.57 times the combined headway), and shuttle riders request on reaching the stop | shuttles if only bus riders use arrival apps; uncertain if shuttle riders could also book ahead | Stated; no variant tests it in Phase 2. Phase 1's sensitivity case with arrival-app riders (κ = 0.35) moves the B fleet; the review's first-order estimate is that Phase 2's savings would fall by roughly a fifth if only bus riders timed their arrival (review R4) |
| No relief or spare staff: on-board staff-hours equal vehicle-hours in service, costed per worked hour, with no allowance for meal-break relief, spares or training | shuttles (with someone on board) | Stated. A 10–15 % relief factor would add about 4–7 % to the cost of every on-board or attendant case without changing the ranking (review R5) |
| Unlimited kerb space in the base case: any number of shuttles can board at once at a station stop | shuttles, most of all B | Stated; the kerb stress tests (10 and 7 shuttles at once per station, test values: the real capacity is unknown) bound it |
| Rides with no bus option (0.4 %) are outside every comparison | neutral | Reported |
| Walking excluded: same stops, no transfers in any option | neutral | Stop-to-stop label everywhere |
| Bus costs: one cost per bus-km for all services; bus supply from published headways | neutral in A–C (cancels) | Only B(ii) and the context figures use it |
| The full bus cost per bus-km (operator fee plus LTA's bus and depot capital) may count LTA's assets twice, because the operator fee includes an undisclosed lease charge for them; the per-km rate also assumes 350 operating days a year against 365 for shuttle fixed costs | B(ii) (a larger avoidable bus cost) | B(ii) reported at both the full cost and the operator fee only (SGD 5.24 per bus-km central) |
| Weekend and holiday days not modelled; annual fixed costs spread over 365 days | neutral | Stated |
| Vehicle prices exclude Singapore registration taxes, COE, import duty and GST; whether AV shuttles need a COE, and in which category, is undecided policy | shuttles, most of all the 4-seat class | Stated; listed as evidence needed. The 4-seat price itself is weakly evidenced (central SGD 150,000, range 60,000–270,000) |
| Remote supervision without a safety operator on board is not permitted for public-road service today; the 1:N ratio is not published | shuttles, in the two remote cases | Three staffing cases reported separately, the current pilot requirement (safety operator on board) first; the remote cases are scenarios, not forecasts |
| No feeder frequency reduction in C: the only published standard is the 8-minute peak feeder headway, 800 and 805 already run at it, and no load profiles are public | buses (C carries no bus saving) | C keeps all buses; B(ii) shows the theoretical bound of withdrawing the internal-only services |
| Fleets come from a simulation grid: B at 400, 450 and 500 (Phase 1 found 450 on a 25-vehicle grid), C in steps of 10–50 vehicles; a service-level fleet is the smallest passing grid point, with every larger simulated fleet also passing | buses (overstates shuttle fleets by up to one step) | Grid and monotone check reported with each service-level fleet (results tables, section 12) |
| Cost sensitivity is one parameter at a time; the low and high cost cases move every parameter together | neutral | Both reported: the tornado for which parameters matter, the cases for the joint range |
