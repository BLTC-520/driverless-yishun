# Decision record — what this project should be

*Written 15 Oct 2026, after reading the brief, testing data access and collecting
research from parallel agents. Status labels: **KNOWN** (verified from a primary
source or our own measurement), **INFERRED**, **ASSUMED**.*

## 1. What the brief really asks

The brief, a ChatGPT-generated research plan, proposes a SUMO microsimulation of
Yishun under 0/20/50/80 % autonomous-vehicle (AV) penetration. On top of that it
adds V2X roadside-unit (RSU) siting, three signal-control strategies, parking-to-kerb
conversion and a large 3D web stack.

Its **intent** is sound and worth keeping:

> Use real Singapore data to ask how a mature town's transport infrastructure should
> adapt to autonomous mobility, and make the answer something people can *see*.

Its **mechanism** (private AVs mixing into general traffic) does not survive the
evidence below.

## 2. Evidence that changed the plan

| Claim | Status | Source | Implication |
|---|---|---|---|
| Singapore's AV deployment is fleet shuttles for intra-town connectivity: Punggol public rides from 1 Apr 2026 (Grab routes 1 and 3, ComfortDelGro route 2), purpose "to enhance connectivity to key amenities and transport nodes for residents within Punggol" | KNOWN | LTA news release, 4 Mar 2026 | The relevant AV question for an HDB town is **fleet shuttles serving local trips**, not private-car penetration. |
| Private-car growth is capped by the Vehicle Quota System and COE, under a car-lite policy | KNOWN | LTA/MOT (red-team agent) | 20–80 % *private* AV penetration is not a plausible Singapore scenario. |
| SUMO ACC/CACC are car-following (headway) models with no communications model; results track the assumed headway | KNOWN | SUMO docs; Shladover et al. 2012; Calvert et al. 2017 | Penetration results would mostly echo our own parameter choices. |
| Singapore's signals run on GLIDE, an adaptive system | KNOWN | LTA | A "fixed-time baseline" would be counterfactual. |
| Junction turning counts exist only as sparse one-day surveys (2017 – May 2024; 18 Yishun workbooks at 07:00–09:00). Signal plans need an NDA | KNOWN | DataMall static page (downloaded and inspected) | General-traffic OD calibration would be weak. |
| RSU disc-coverage siting is Church's maximal covering problem; greedy achieves (1 − 1/e). No LTA RSU deployment found | KNOWN / INFERRED | Church 1974; Nemhauser et al. 1978 | Not a contribution. |
| **LTA fare-card OD volumes at stop-pair × hour resolution are available with the user's DataMall key** | **KNOWN** (Sept 2026 file downloaded) | DataMall `PV/ODBus` | **Observed** demand, not synthetic: about 158,000 bus rides per weekday start and end inside Yishun. |
| The median internal ride is about 1.06 km straight-line; 68 % touch an MRT/interchange stop; the peak hour (07:00) carries about 14,800 rides | KNOWN (our computation) | same | Very short, hub-focused feeder trips: waiting time dominates. |
| Closest prior work: Shen, Zhang & Zhao 2018 (TR-A) — shared AVs for first-mile service in **one low-demand area**, **2-h AM peak**, **assumed mode split**, up to 35 vehicles | KNOWN | DOI 10.1016/j.tra.2018.04.004 | Gap: a whole mature town, all day, with observed 2026 demand, in an open, reproducible model. |
| Live GPS-based bus arrival estimates allow calibration of real running times | KNOWN (our collection) | DataMall `v3/BusArrival` | Road speeds, signal delay and bus dwell can be calibrated, not assumed. |

## 3. Alternatives considered

| Direction | Question | Verdict |
|---|---|---|
| **A. The brief as written**: SUMO, private-AV penetration, signals, RSUs, kerbs | How does mixed autonomy change traffic? | Implausible frame for Singapore, uncalibratable, results set by assumed headways, very high effort. **Rejected.** |
| **B. Autonomous feeder replacement with observed demand** *(chosen)* | What would it take for on-demand autonomous shuttles to carry Yishun's internal bus trips, hour by hour, and what changes physically? | Real stop-pair demand, calibrated network, policy-aligned, clear gap, fully verifiable simulator, visual. |
| C. Vertical access for 65+ residents (lift waits and stairs) | How do lifts and stairs shrink older residents' access? | Original, but per-block lift data is unavailable and validation needs fieldwork. Kept as a future equity extension. |
| D. AV-readiness (operational design domain, ODD) index tested against Punggol routes | Can a transparent ODD score separate pilot corridors? | Only about three pilot routes and subjective weights; weak test. Kept as a possible *service-area constraint* inside B. |
| E. Idle-carpark land via historical carpark availability | How much parking is idle, and where? | Feasible (the history API works) but off the autonomy question. Possible later layer. |
| F. Shade corridors, ecological pinch points, lease decay | — | Off-theme for this portfolio. |

Scoring (1–5, our judgement): B leads on data reality (5), credibility and
verifiability (5), policy relevance (5), visual potential (4) and feasibility (4).
A scores 2 on credibility. C and D score 3 on validation.

## 4. The chosen question

> **Could autonomous on-demand shuttles carry the bus trips Yishun residents make
> inside their own town, and what would that require?**
>
> - **Fleet:** how many vehicles, of what size, hour by hour, to match today's buses?
> - **Kerb:** how much kerb space at the MRT stations?
> - **Distance:** how many more vehicle-kilometres?
> - **Distribution:** who gains and who loses?

**One system:** an event-driven, pooled, stop-based shuttle simulator on a calibrated
road network, driven by observed fare-card OD, compared against a common-lines model of
the current bus network built from LTA routes and headways.

**One experiment:** fleet size × vehicle capacity (4 / 10 / 20 seats), replicated
over Poisson demand draws. The output is a "replacement frontier": the smallest fleet
that matches the buses' door-to-door time in each hour, plus resource costs.

**One interaction:** a 3D Yishun (real HDB block heights) where you scrub a
weekday and watch observed demand and simulated shuttles move, switching between
fleets that actually were simulated.

## 5. What we will not claim

- Not a forecast of AV adoption, ridership response, fares or costs.
- Demand is held at today's observed bus rides: no induced or shifted demand.
- No traffic interaction: shuttles do not congest roads in the model. Peak-hour
  congestion is a stated limitation, partly addressed by calibration.
- Not a safety or perception study.
