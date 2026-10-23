# Phase 2 charts

Written by `python -m yishun.phase2.charts` from `data/processed/phase2/summary.json`.

## tradeoff.png

![tradeoff](tradeoff.png)

Every simulated configuration: additional operating cost per weekday against Option A (central cost case, all buses kept) and passenger-hours saved per weekday on the same rides (mean of the simulated days), with a safety operator on board (the current pilot requirement). The black line joins the configurations that save more than every cheaper one; grey rays mark constant cost per passenger-hour saved. Crosses: service not acceptable (more than 1 % of offered rides declined in some hour, or riders refused). Costs are modelled from the parameter register; times are simulated (shuttles) and modelled (buses).

## tradeoff_staffing.png

![tradeoff_staffing](tradeoff_staffing.png)

The best saving for the cost under each staffing case (central cost case, all buses kept). Passenger time does not depend on staffing, so each reference configuration keeps its height and moves left as staffing falls (grey lines).

## cost_classes.png

![cost_classes](cost_classes.png)

Shuttle operating cost per weekday by class for the reference configurations, central case (bar) and low-to-high cost cases (line), for each staffing case.

## passenger_time.png

![passenger_time](passenger_time.png)

Passenger-hours per weekday on the same rides, stop to stop: waiting (lighter) and in-vehicle (full). Bus times are modelled; shuttle times are simulated.

## periods.png

![periods](periods.png)

Passenger-hours saved per weekday against Option A, by the period in which the ride is requested (sums over the period).

## tornado.png

![tornado](tornado.png)

Cost per passenger-hour saved when one cost parameter at a time moves to its low-cost or high-cost value (the others central), for the focus C configuration of each staffing case; the ten widest swings.

## budget.png

![budget](budget.png)

The most passenger-hours saved per weekday by any configuration with acceptable service whose additional cost (central case, all buses kept) is within the budget, for each staffing case; diamonds mark where the best is a B configuration (elsewhere it is a C configuration). Faint vertical lines: the budgets of the report's budget table. There is no single acceptable cost.
