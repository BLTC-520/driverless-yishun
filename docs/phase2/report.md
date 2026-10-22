# Driverless Yishun, Phase 2: what would a combined bus and shuttle service cost, and whose time would it save?

*Draft. Sections marked (pending) are filled from `data/processed/phase2/summary.json` after the
final runs.*

## Question

Can a combined bus and autonomous shuttle service save passenger time at an acceptable additional
operating cost?

## Answer in brief

(pending)

## Options compared

| | Option | What runs | Bus service |
|---|---|---|---|
| **A** | Current bus | Today's routes and published headways (Phase 1 bus model) | As today |
| **B** | Full shuttle replacement | A fixed fleet of pooled shuttles carries every internal ride (Phase 1's definition) | (i) all buses kept, or (ii) a theoretical bound: the 15 services that carry only internal riders withdrawn |
| **C** | Combined bus + shuttle | Shuttles carry the rides that today's timetable serves worst; every other ride stays on the bus | All buses kept |

- B is a theoretical replacement scenario, not a bus withdrawal plan. Its bus case (ii) shows
  the most bus cost a full replacement could avoid.

**Option C's rule ("timetable gap").**
- A ride from stop *o* to stop *d* requested at minute *t* is offered a shuttle when the bus is
  expected to be slow for it. The test: the expected bus stop-to-stop time exceeds a direct drive
  between the two stops, plus the shuttle's two stops, by at least θ minutes.
  - The expected bus time is built from LTA's published routes, headways and first/last-bus times.
- Everything the rule uses is published before the passenger travels, so eligibility is a fixed
  table of stop pairs by time of day. The rule never uses the wait a passenger happens to get on
  the day.
- θ sets the coverage, from 4 to 16 minutes.
- A shuttle request is declined if the best quoted pickup is more than 15 minutes away. The rider
  then takes the bus at today's time.
- A variant confines the shuttle to the period with the longest headways, after 20:00.

**Why this rule.** Phase 1 found two things:
- Full replacement needs 450 ten-seat shuttles, because of the 07:00 rush, when buses are most
  frequent.
- Shuttle gains are largest where bus routes loop and headways are long.

A rule that sends shuttles only where the bus is slow should therefore save more time per vehicle
than full replacement.

## What is observed, simulated and assumed

| Status | What |
|---|---|
| **Observed** | Internal bus rides by stop pair and hour (LTA fare-card OD, July–August 2026); all Singapore bus rides, for who uses Yishun's bus-km; LTA routes, headways and first/last buses; road network (OSM, pinned 22 Oct 2026); calibration of road speeds, dwell and headway regularity on LTA's live bus data (Phase 1) |
| **Simulated** | Shuttle waits, rides, refusals and declines, vehicle-km, vehicle-hours and kerb use (event-driven simulator, Phase 1, unchanged) on Poisson demand days around the observed average weekday |
| **Modelled** | Bus waits and in-vehicle times (common-lines model on published headways); bus-km and bus-hours inside Yishun |
| **Evidence, with ranges** | Costs: vehicle price, energy, maintenance, insurance, software, staffing, chargers and depot, bus cost per km (source register `data/parameters/cost_register.csv`) |
| **Assumed** | Values with no usable evidence, labelled in the register; the availability estimate (not a charging simulation); demand fixed at today's rides; no congestion feedback |

## Results

### Passenger time (pending)

### Cost (pending)

### Trade-offs (pending)

### Who gains and who loses (pending)

### What controls the conclusion (pending)

### Stress tests (pending)

## Which options merit further study (pending)

## Evidence needed before a deployment decision (pending)

## Limits

See `docs/phase2/limits.md` for each limit, whom it favours, and how it is handled.

## Reproduce (pending)
