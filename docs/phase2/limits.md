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
| Rides with no bus option (0.4 %) are outside every comparison | neutral | Reported |
| Walking excluded: same stops, no transfers in any option | neutral | Stop-to-stop label everywhere |
| Bus costs: one cost per bus-km for all services; bus supply from published headways | neutral in A–C (cancels) | Only B(ii) and the context figures use it |
| Weekend and holiday days not modelled; annual fixed costs spread over 365 days | neutral | Stated |
| Vehicle prices exclude Singapore registration taxes, COE, import duty and GST; whether AV shuttles need a COE, and in which category, is undecided policy | shuttles, most of all the 4-seat class | Stated; listed as evidence needed. The 4-seat price itself is weakly evidenced (central SGD 150,000, range 60,000–270,000) |
| Remote supervision without a safety operator on board is not permitted for public-road service today; the 1:N ratio is not published | shuttles, in the two remote cases | Three staffing cases reported separately, the current pilot requirement (safety operator on board) first; the remote cases are scenarios, not forecasts |
| No feeder frequency reduction in C: the only published standard is the 8-minute peak feeder headway, 800 and 805 already run at it, and no load profiles are public | buses (C carries no bus saving) | C keeps all buses; B(ii) shows the theoretical bound of withdrawing the internal-only services |
| Fleets come from a simulation grid (steps of 25–50 for B, 5–25 for C); a service-level fleet is the smallest passing grid point, with every larger simulated fleet also passing | uncertain (overstates fleets by up to one step) | Monotone check reported with each service-level fleet |
| Cost sensitivity is one parameter at a time; the low and high cost cases move every parameter together | neutral | Both reported: the tornado for which parameters matter, the cases for the joint range |
