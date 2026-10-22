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
