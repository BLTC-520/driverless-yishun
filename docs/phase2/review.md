# Phase 2 independent review

*23 Oct 2026. An independent review of the Phase 2 study (options A, B and C), written to the
lead's brief.*

**What was reviewed.** The working tree at HEAD `5334f5a` on `claude/determined-hopper-lbbu5k`.
- The brief names `5b90d1d`. `5334f5a` is the next commit, made during this review; it changes only
  `README.md`, `docs/methodology.md` and `docs/validation.md`.
- The runs (built at `6e0c8ab`), `summary.json` (built at `1c531e5`), the tables, the charts, the
  page data and `report.md` are those of `5b90d1d`.

**Method.**
- I read the definitions, limits and audit, the Phase 2 code, the Phase 1 simulator and bus
  model, the parameter file, the register and both evidence notes, and the outputs. I read the
  report last, then checked its claims.
- Computations on the outputs and on the cached model (`data/interim/model_213e91ad1ee8.pkl`):
  - regenerated seed 1's requests, Option A's totals and C's eligibility tables;
  - recomputed costs by hand from `cost_cases.json`;
  - rebuilt `summary.json` in memory from the committed runs, writing it outside the repository.
- **One short simulation (4 s):** the recorded job `base|C:C10:N40:th14|…|s1` from
  `refine/config.json`. It tests reproducibility and measures R1 on the rides actually carried.
- I ran no git command. The summary rebuild calls the pipeline's `provenance()`, which runs
  `git rev-parse` and `git status` read-only. HEAD was read from `.git/HEAD`.
- Test suite: 505 passed, 19 skipped.

## Findings

### R1 · material · The bus model boards riders at a stop's first visit on a line. On service 812 this inflates Option A's time by about 505 passenger-hours a day, and C carries those rides at every θ.

**Evidence.**
- `busnet.py:134` keeps only the first position of each stop on a line (`pos.setdefault(c, k)`).
  `options()` (`busnet.py:165–171`) measures in-vehicle time from that position to the next visit
  of the destination. `phase2/bus_allocation.py:53–56` uses the same rule.
- Feeder 812 is a figure of eight through Yishun Interchange. LTA's BusRoutes lists stop 59009 at
  StopSequence 1, 14 and 34, with a first bus of 05:30 at both 1 and 14
  (`data/raw/lta/bus_routes.json`).
  - A rider boarding at the interchange for the second loop is therefore modelled as riding the
    whole first loop first (26.3 min).
- **Example: Yishun Int → Blk 121 (59121), 544 rides a day.**
  - Modelled in-vehicle time: 34.9 min. From the second visit (sequence 14): 8.6 min. Direct
    shuttle drive: 5.3 min.
  - Its timetable gap is 33.6 min, of which 26.3 min is the first loop.
  - It is the largest pair in θ 14's offer, and three of θ 14's five largest pairs are this
    artefact. Phase 1's check of loop times (`validation.md:91`) compares end-to-end loop times,
    which this error does not change.
- **Recomputed with boarding allowed at any visit, all else unchanged:**
  - 339 OD-hour cells change, all from 59009: 1,261 rides a day, overstated by 505
    passenger-hours (1.6 % of A's 32,559).
  - 504–505 of those hours fall on rides that rule C-θ offers at every θ from 4 to 16 min.
- **Seed 1:** 1,283 rides, 507.9 h.
- **Re-run of C θ 14 × 40, seed 1** (identical to the recorded run): 1,228 of the rides it
  carried are affected, carrying 505.8 h. Its saving falls from 2,145.7 to 1,639.9 h.

**What it changes.** First-order correction: same fleets and same carried rides, central costs, all buses kept.

| Configuration | Saved h a day | SGD per h saved, on board | SGD per h saved, remote only | Value ÷ cost, on board | Value ÷ cost, remote only |
|---|---|---|---|---|---|
| B 450 | 14,446 → 13,941 (−3.5 %) | 41.3 → 42.8; B (ii) 34.4 → 35.6 | 23.8 → 24.7; B (ii) 16.8 → 17.4 | 0.57 → 0.55 | 0.99 → 0.96 |
| C θ 6 · 275 | 10,602 → 10,098 (−4.7 %) | 34.6 → 36.3 | 20.1 → 21.1 | 0.67 → 0.64 | 1.15 → 1.10 |
| C θ 8 · 175 | 7,250 → 6,746 (−6.9 %) | 32.4 → 34.8 | 19.0 → 20.4 | 0.69 → 0.65 | 1.18 → 1.11 |
| C θ 10 · 100 | 4,553 → 4,050 (−11 %) | 29.9 → 33.6 | 17.6 → 19.8 | 0.72 → 0.65 | 1.23 → 1.10 |
| C θ 14 · 40 | 2,151 → 1,648 (−23 %) | 26.2 → 34.2 | 16.0 → 20.8 | 0.80 → 0.62 | 1.31 → 1.02 |

- **Headline cost range.** C's SGD 26–35 per passenger-hour (on board) becomes about SGD 34–36.
  The fall in cost per hour with narrower targeting disappears. That fall is the stated reason to
  prefer θ 8–14 over θ 6 (report lines 330–331).
- **C against B.** C and B (ii) become level per hour saved (R2). With remote supervision only,
  700 four-seat B vehicles (about SGD 17.3) and B (ii) (17.4) become cheaper than every C
  reference design (20–21).
- **Value-of-time threshold.** "Met at central costs" with remote supervision (report line 260;
  θ 8, 10 and 14 in summary.json) holds for none of the reference designs after correction. At
  θ 8 the cost is SGD 137,535 a day against a threshold of 19.7 × 6,746 = SGD 132,900.
- **Value ÷ cost.** The report quotes 0.67–0.80 (on board) and 1.15–1.31 (remote) for C. Corrected,
  these fall to 0.62–0.65 and 1.02–1.11.
- **Budget table.** The smallest budgets lose most: at SGD 50,000 (θ 16 · 30), 1,613 h become about
  1,110 h, and SGD 27 an hour becomes SGD 39.
- **A full re-run** would also drop 915–1,146 rides a day from the θ ≥ 8 offers (14 % at θ 14).
  Those fleets could then shrink by up to one grid step, so θ 14 would end nearer SGD 31–34 an
  hour than 26.
- **Elsewhere.** The same error is in Phase 1's bus baseline (day mean 11.97 min, about 1.6 % high).
  It also affects the bus allocation, where 812's internal passenger-km are about 6,600 too high:
  the internal share is about 53.2 %, not 53.7 % (negligible).

**Fix.**
- In `BusBaseline.options`/`_serving` and in `bus_allocation.line_pairs`, board at whichever
  visit of the origin stop gives the shortest ride to the destination, or split 812 into its two
  loops.
- Add a test with a figure-of-eight line. It should also cover lines 861, 883 and 883M, which
  revisit stop 58621; no cell changes there today.
- Rebuild the model (new key) and the cell-gap table. Re-run every grid and regenerate the
  summary, tables, charts and page.

### R2 · material · "C buys time more cheaply than any full replacement" holds only with all buses kept

**Evidence.**
- summary.json `costs`, central case, B-10-450 with the internal-only services withdrawn:
  - safety operator on board: SGD 34.37 per hour saved, against C θ 6's 34.60;
  - attendant on board: 34.02 against 34.34;
  - remote only: B (ii) 16.8, and B-4-700 16.8 with all buses kept, against C's 16.0–20.1.
- After R1, C is at 34–36 and B (ii) at 35.6 (on board).
- The claim is made in report line 17 and on the page (`web/src/index.html:619`) without this
  qualification.
- The report's §2 cost table (lines 126–135) gives B (ii)'s added cost but not its cost per hour
  saved, so the overlap is invisible to the reader.

**What it changes.** The second headline bullet. At the theoretical bound of bus withdrawal, B and
C cost about the same per hour saved.

**Fix.**
- Say "than full replacement with all buses kept".
- Add B (ii)'s cost per hour saved to the §2 table.
- State that B (ii) is level with C (within about 6 % after R1).

### R3 · material · The stress tests compare different service designs, and the report generalises the result

**Evidence.**
- **Different rules.**
  - B accepts quoted pickups up to 45 min, and refuses beyond that with no bus fallback
    (`runs.py:107–110, 134–137`).
  - C declines beyond 15 min, and the rider takes the bus at Option A's time
    (`runs.py:111–118, 138–139`).
  - B (i) keeps every bus (definitions §2), so the same fallback was available to B but was not
    modelled.
- **Where B's losses come from.** Much of the collapse comes from long accepted waits, not
  refusals. With shuttles 25 % slower, B 450 saves only 3,736 h with no refusals. With 15 % of the
  fleet unavailable, it saves −8,065 h.
- **Kerb stresses.** The dispatcher does not anticipate kerb queues
  (`docs/methodology.md:214–216`; Phase 1 README item 7: "adding vehicles makes it worse"). So at a
  10-berth kerb, B 500 does worse than B 450 (−126,790 against −113,445 h).
- **"Realistic" is not evidenced.** The 7- and 10-berth limits are test values. The report lists
  kerb capacity as evidence still needed (line 359), yet calls them "realistic kerb limits"
  (line 44).
- Statements affected: report lines 33–36, 44, 274–275 and 335–336.

**What it changes.** "C degrades gracefully; B does not" is partly a property of the B design that
was simulated, not of full replacement as such. It is also one of three reasons the report gives
for not studying B further.

**Fix.**
- Run the B (i) stresses under C's rule. `OptionSpec("C", theta_min=ALL_RIDES, fleet=450)` is
  exactly B with a 15-minute decline to the bus. Alternatively, state the asymmetry beside every B
  stress figure.
- Replace "realistic kerb limits" with "kerb limits of 10 or 7 shuttles per station (test values;
  capacity unknown)".
- Keep the reasons that stand on their own: 3 times the vehicles and 4.7 times the kilometres.

### R4 · minor · Unstated assumption: no rider uses arrival information

**Evidence.**
- Bus waits are κ/Σf for random arrivals at every headway, including 10–20 min (`busnet.py:8`;
  `experiments.py:41–58`). Shuttle riders request on arrival at the stop.
- limits.md does not mention this. Phase 1 ran a live-arrival-app case (κ = 0.35,
  `sensitivity.py:84`); Phase 2 did not carry it.
- **If only bus riders time their arrival (κ = 0.35),** savings fall by:

  | B | C θ 6 | C θ 8 | C θ 10 | C θ 14 |
  |---:|---:|---:|---:|---:|
  | 24 % | 21 % | 19 % | 18 % | 13 % |

- **If shuttle riders can also request before reaching the stop,** their simulated waits are
  hidden too (B 3,233 h; C θ 6 2,062 h), and the net change is −1 % to +9 %.

**What it changes.** The size of the saving. The direction depends on the information each mode is
assumed to give riders; the bus-error table (§9) brackets the size.

**Fix.** Add the assumption to limits.md and report both variants.

### R5 · minor · Two further unstated assumptions favour the shuttles

**Evidence and what it changes.**
- **(a) No staff relief.** Staff-hours equal vehicle-hours in service (`costs.py:451–461`), at a
  cost per worked hour (G31: 2,179 h a year after leave). There is no allowance for meal-break
  relief, spare staff or training.
  - A 10–15 % relief factor adds about 4–7 % to shuttle cost with an operator or attendant on
    board: SGD 27,000–40,000 a day for B 450, SGD 10,000–15,000 for C θ 8.
  - Rankings do not change.
- **(b) Unlimited kerb in the base case.** B needs up to 29 shuttles boarding at once at Yishun
  and 18 at Khatib (results §2). Phase 1 states this; limits.md does not. The stress tests bound it.

**Fix.** Add a relief factor (or state its absence), and add the kerb assumption to limits.md.

### R6 · minor · The bus cost per bus-km may count LTA's assets twice

**Evidence.**
- BCM tender prices include "lease charges for assets provided by LTA" (register G01–G07,
  inclusions). Bus capital (SGD 0.73/km) and depot capital (0.62/km) are added on top, giving a
  central SGD 6.6/km against 5.24 for the operator fee alone (`cost_cases.json` note). The risk is
  flagged in `sources_sg.md` lines 83 and 517.
- Two further basis differences:
  - the per-km rate understates the slow feeders' cost: on a per-hour basis the 15 services cost
    1,225.5 bus-hours × SGD 91 = SGD 111,500, 11 % more;
  - the bus rate assumes 350 equivalent days a year, while shuttle fixed costs use 365.

**What it changes.**
- With the fee-only rate, the B (ii) avoidable bound is SGD 79,900, not 100,600 (−21 %). B (ii)'s
  added cost rises 4 % (on board: SGD 34.4 → 35.8 an hour).
- The context bus cost per internal ride becomes SGD 0.58, not 0.74.
- Only B (ii) and the context figures are affected; the bus cost cancels in every A–C comparison.

**Fix.** Show B (ii) with both the fee-only and the full-cost rate, and state the basis in limits.md
and the report.

### R7 · minor · Reproducibility: LTA's static bus files are not pinned

**Evidence.**
- `data/raw/` is git-ignored (`.gitignore:1`), and `make data` (Makefile lines 12–17) downloads
  today's BusRoutes, BusServices and BusStops.
- These three files define the bus model, C's eligibility table, the internal-only services and
  the bus supply.
- Provenance stores only their digests (`model.py:33–44`), so a changed download is detected but
  cannot be undone.
- The report's Reproduce block (line 376) implies that the inputs are pinned.

**What it changes.** Exact rebuilds fail after LTA's next route or headway update.

**Fix.** Commit the three files (about 8 MB raw) xz-compressed with SHA-256 checksums, like the OSM
extract, add a restore command, and say so in the report.

### R8 · minor · Report statements that are wrong or stronger than the outputs

**Evidence.**
- **(a) Vehicle size, lines 340–342:** "4-seat vehicles look cheaper only with remote supervision
  only". This is wrong.
  - With an operator on board, C θ 10 with 150 four-seat vehicles costs SGD 28.7 per hour saved,
    against 29.9 for ten-seat (high case: 57.4 against 62.4).
  - Four-seat designs sit on the on-board frontier (C-4-150/175/200-th10, C-4-450-th6).
  - The report's own budget table picks "C θ 10, 150 four-seat" at SGD 150,000 (line 188).
- **(b) Line 23:** "Staffing controls the conclusion more than any other input". Staffing moves
  C's cost per hour by about −40 %. A 20 % bus-time error moves it by +69 % (§9), and R1 alone
  moves θ 14's by +31 %.
- **(c) Line 116:** "No reference design declines … a ride". The run files show one or two
  declines on some days (θ 8 seed 1; θ 10 seeds 1, 3 and 6; θ 14 seeds 1 and 3). Line 224 itself
  says "under one ride a day on average".
- **(d) Line 89** lists calibrated road speeds, dwell and headway regularity as "Observed". They
  are parameters fitted to LTA's arrival estimates (`validation.md:53, 160`), and headways before
  06:30 are assumed (`busnet.py:33`).
- **(e) Stress table, lines 291–300.**
  - It omits several decline and refusal counts:
    - C θ 6: 41 declined with slower roads, 347 with slower shuttles;
    - C θ 8: 387 declined with 15 % unavailable, 834 in the combined stress;
    - C θ 14: 9 and 38 declined in the same two stresses;
    - combined stress: B 450 refuses 61,272 riders and B 500 refuses 60,549.
  - Its base row is the 10-day mean, while the stress rows are 3-day means. B 450 over seeds 1–3
    saves 14,554 h, not 14,446.
- **(f) Line 304:** "kerb limits barely touch them". C θ 6 loses 22 % with 7 berths and 30 % in
  the combined stress. In line 305, "buses and shuttles alike" does not hold for the shuttles-only
  stress.
- **(g) Lines 280–281:** the cost per hour "would rise in proportion". It rises by 1/(1 − loss):
  by 25 %, 69 % and 156 % for losses of 20, 41 and 61 %.
- **(h) Line 231:** "9–25 % fewer shuttles". The 45-minute fleets are the smallest ones simulated,
  so this should read "at least 9–25 %".
- **(i) Lines 201–202, and the limits list (lines 361–371),** do not flag that early-morning gains
  rest on assumed pre-06:30 headways. The effect is small (see the checks that passed), but
  limits.md row 14 asks for the flag.

**What it changes.** One wrong conclusion on vehicle size (a); elsewhere, wording, emphasis and the
visibility of declines and refusals.

**Fix.** Correct the wording.

### R9 · minor · Defects in the generated tables and charts

**Evidence.**
- In results.md §5, the "By subzone" rows have blank names: `report_tables.py:170` reads
  `r.get("subzone")`, but the rows carry `sz` and `label`.
- The hub and band tables print True/False and 0–5 instead of their labels.
- In §1, A's "Days" cell shows "11.9–12.0", a range of mean minutes rather than a day count
  (`report_tables.py:76–77`).
- The chart formatter (`charts.py:55`) rounds half-thousands to even. The y-axis of
  `tradeoff.png` reads 0k, 2k, 5k, 8k, 10k, 12k, 15k for 0, 2,500, 5,000, 7,500, 10,000, 12,500
  and 15,000.

**What it changes.** Presentation only.

**Fix.** Use the `label` field and `n_seeds`, and format thousands with one decimal when they are
not whole.

## Checks that passed

- **Same rides, seeds and boundary.**
  - Ride counts, no-bus counts and A passenger-hours are identical across options within each seed
    and scenario.
  - Seed 1 regenerates exactly: 163,474 rides; A = 32,610.877 h; p90 20.0 min.
  - The eligibility digests match the runs: 25776b7e4d, 7ac859ef10, 3b5d82b0fd, 66b5fca080.
- **Rule C-θ uses only information known in advance.**
  - Eligibility uses the expected bus time at the request minute (`assign.py:32–40`,
    `experiments.py:72`).
  - Repositioning uses the expected offered rates (`assign.py:68`).
  - Simulated bus waits are used only for distributions (`runs.py:142–144`).
  - Stress runs keep the base-case table and rates (`phase2/experiments.py:97–103`).
  - No path from realised waits or future requests was found.
- **Ride accounting.** Each ride has one mode, and the counts add up. Refused and declined rides
  are reported separately in every run and table. The frontier and budget tables use acceptable
  configurations only.
- **R1–R3 treatments.** Applied as defined (`runs.py:189–199`). The choice changes no base-case
  result and no frontier: the largest R2 loss among acceptable configurations is 1.4 h, and the
  frontiers under R1, R2 and R3 are identical.
- **Fleet standards.**
  - B 450 refuses no one on any of 10 days; 400 fails.
  - B's worst hour has a p90 of 14.0 min, so B is probably close to C's 15-minute standard. The
    share of B pickups beyond 15 min is worth reporting.
  - The service-level fleets are monotone.
- **Bus cost.**
  - It cancels in A–C and B (i).
  - B (ii) subtracts only the 15 internal-only services. In `bus_allocation.json`, each has 100 %
    internal passenger-km and runs entirely inside the area.
  - The passenger-km key is computed as defined, with the ride key shown beside it.
- **Cost model, recomputed by hand from `cost_cases.json`.**

  | Configuration | Daily cost | Per hour saved | Total fleet | Chargers |
  |---|---:|---:|---:|---:|
  | B 450 | SGD 597,157 | SGD 41.34 | 561 | 281 |
  | C θ 8 × 175 | SGD 235,043 | SGD 32.42 | 220 | 110 |
  | C θ 14 × 40 | SGD 56,355 | SGD 26.20 | 51 | 26 |

  - Bus: SGD 223,547 for all services; SGD 100,626 avoidable.
- **Register against the parameter file.**
  - FX and CPI conversions check for A18, A19, A22, A26, G01, G04, G31 and G66.
  - The bus capital and depot annuities reproduce (SGD 0.73 and 0.62 per km).
  - The central vehicle price, SGD 540,000, matches the median of the six observations (544,251).
  - Bundled figures (A72, A25) stay out of the prices.
  - Purchase and lease are exclusive (`costs.py:482–486`).
  - 36 parameters and 247 register rows; every source resolves.
  - On the shuttle side, nothing is counted twice (the software fee is set below the bundled
    support fee).
- **Availability estimate.** It follows definitions §7: a 3.1-hour overnight window, and a B
  charging reserve of 43 (9.6 %). It is labelled an estimate in results §2, report §2, the
  report's "Assumed" row and the page.
- **Disclosure.** The spread across simulated days is called random variation only (report lines
  117–118, results §1, page tooltip). Congestion feedback is disclosed wherever the speed stresses
  appear (results §8, report lines 305–306, the page).
- **Pre-06:30 headways** (limits.md row 14). Using the daytime off-peak band instead lowers C's
  savings by only 8–74 h (θ 14 to θ 6).
- **Reproducibility.**
  - `summary.json`, rebuilt from the committed runs at HEAD, is identical in every value except
    the provenance commit.
  - The recorded job re-runs to the last digit: 30,465.188 passenger-hours and 14,451.45
    vehicle-km.
  - The OSM extract, the OD table and the calibration are committed, and every grid's
    `config.json` records its jobs, seeds and digests.
- **The report's other numbers** match results.md and summary.json:
  - the headline savings and costs;
  - the frontier switch points (on board: SGD 530,781 central, 270,005 low and 1,101,053 high;
    remote only: 269,555, 64,645 and 839,535);
  - the tornado swings, the budget rows, the period shares and the social ratios;
  - 62 of 62 acceptable configurations, 468 runs, 36 parameters and 247 register rows.
  - Definitions §2's coarse-analysis figures also check: 29 % of rides, 51 % of the gap, and
    about 4,100 rides in the busiest hour against 16,100.
