# Decision record — what this project should be

*Written 15 Oct 2026, after reading the brief, testing data access and collecting
research from parallel agents; revised the same day after three red-team reviews.
Status labels: **KNOWN** (verified by us from a primary source or our own measurement),
**REPORTED** (a secondary source, not independently verified), **INFERRED**, **ASSUMED**.*

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
| Singapore's AV deployment is fleet shuttles for intra-town connectivity: Punggol public rides from 1 Apr 2026 (Grab routes 1 and 3, ComfortDelGro route 2), purpose "to enhance connectivity to key amenities and transport nodes for residents within Punggol"; planned flat fare $4 | KNOWN (read by us) | LTA news release, 4 Mar 2026 | The relevant AV question for an HDB town is **fleet shuttles serving local trips**, not private-car penetration. |
| "Today, we only have 16 passenger vehicles, all in Punggol"; about 20,000 riders; next: point-to-point service "within the whole estate, without the need for fixed routes"; then HDB towns Tampines North and Tengah | KNOWN (read by us) | MOT, Minister's remarks, 18 Sep 2026 | The on-demand model is what we simulate (between existing stops). Yishun is not on the list, which makes this a "what would it take" study, not a plan. |
| Grab pilots an on-demand service "between existing pick-up and drop-off points" on routes 1 and 3, taking the most direct path; more than 11,500 riders by 12 Jul 2026 | KNOWN (read by us, via search summary of the release) | LTA news release, 29 Jul 2026 | Same service type as the simulation: on demand, between fixed points. |
| LTA stopped a planned autonomous-bus pilot on services 400 and 191 to look at narrower uses first | REPORTED (LTA confirmed to the publication) | Mothership, 13 Oct 2026 | Large-scale replacement of public buses is not on the near-term agenda; this is an exploratory study. |
| Deployed vehicles are small: WeRide GXR (5 seats) and Robobus (8 seats) | REPORTED (operator release, via research agent) | WeRide, 22 Sep 2025 | Our 4- and 10-seat cases bracket real vehicles. |
| Bus-captain shortage is the stated motivation for autonomous buses | REPORTED (via research agent; MOT Committee of Supply 2026) | MOT, 4 Mar 2026 | Replacing drivers is the policy hook; fleet size and kerb space are our counterweights. |
| Private-car growth is capped by the Vehicle Quota System and COE, under a car-lite policy | KNOWN | LTA/MOT (red-team agent) | 20–80 % *private* AV penetration is not a plausible Singapore scenario. |
| SUMO ACC/CACC are car-following (headway) models with no communications model; results track the assumed headway | KNOWN | SUMO docs; Shladover et al. 2012; Calvert et al. 2017 | Penetration results would mostly echo our own parameter choices. |
| Singapore's signals run on GLIDE, an adaptive system | KNOWN | LTA | A "fixed-time baseline" would be counterfactual. |
| Junction turning counts exist only as sparse one-day surveys (April 2017 – May 2024 across Singapore; 60 Yishun workbooks at 31 sites, the latest January 2024). Signal plans need an NDA | KNOWN | DataMall static page (downloaded and inspected) | General-traffic OD calibration would be weak. |
| RSU disc-coverage siting is Church's maximal covering problem; greedy achieves (1 − 1/e). No LTA RSU deployment found | KNOWN / INFERRED | Church 1974; Nemhauser et al. 1978 | Not a contribution. |
| **LTA fare-card OD volumes at stop-pair × hour resolution are available with the user's DataMall key** | **KNOWN** (July, August, September 2026 files downloaded) | DataMall `PV/ODBus` | **Observed** demand, not synthetic: about 164,000 bus rides per school-term weekday start and end inside Yishun (158,000 in September, which has a school-holiday week). Each is a ride (stage), not a linked trip. |
| The median internal ride is about 1.1 km straight-line; about two-thirds touch an MRT/interchange stop; the peak hour (07:00) carries about 16,100 rides | KNOWN (our computation) | same | Very short, hub-focused feeder trips: waiting time dominates. |
| Closest prior work in Singapore: Mo et al. 2021 (TR-C 127) — shared AVs **competing** with buses for first-mile trips in Tampines; agent-based, operators set fleets and headways in equilibrium | KNOWN (abstract read) | DOI 10.1016/j.trc.2021.103058 | Different question: market competition with mode choice. Ours holds demand fixed at observed stop-to-stop rides and asks what replacing **every** internal bus ride of a mature town would take, all day, in vehicles, km and kerb. |
| Other prior work: Shen, Zhang & Zhao 2018 (TR-A) — shared AVs for first-mile service in one low-demand area, 2-hour AM peak, 52 scenarios | REPORTED (metadata and a secondary review; abstract confirms the AM-peak first-mile design) | DOI 10.1016/j.tra.2018.04.004 | Same family; smaller area and window. |
| Demand-responsive feeders beat fixed routes only below about 10–50 riders per sq mile per hour | KNOWN (abstract read) | Li & Quadrifoglio 2010, TR-C 18(5) | Yishun's 07:00 internal demand is about 2,000 per sq mile per hour: theory predicts a high price for on-demand service, which is what the simulation finds. |
| Live GPS-based bus arrival estimates allow calibration of real running times; the positions they carry allow a check against observed bus movement | KNOWN (our collection) | DataMall `v3/BusArrival` | Road speeds, signal delay and bus dwell can be calibrated, not assumed, and tested on independent observations. |

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
over Poisson demand draws. The output is the smallest fixed fleet that matches the buses'
stop-to-stop time in every hour (with the largest fleet that fails), plus resource costs.
Hour-by-hour requirements are reported as lower bounds.

**One interaction:** a 3D Yishun (real HDB block heights) where you scrub a
weekday and watch observed demand and simulated shuttles move, switching between
fleets that actually were simulated.

## 5. What we will not claim

- Not a forecast of AV adoption, ridership response, fares or costs.
- Demand is held at today's observed bus rides: no induced or shifted demand, and two-bus
  trips are not merged into one shuttle ride.
- Riders are not "residents": the data count where people board and alight inside Yishun.
- No traffic interaction: shuttles do not congest roads in the model. Evening-peak speeds
  are measured and tested; the morning peak is not observed.
- Not a safety or perception study.
