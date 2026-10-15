# Data registry

All sources were accessed on **15 October 2026**. Raw files live in `data/raw/` and are
not committed. Each has a `manifest.json` with the retrieval time. `make data` re-downloads
everything still available; an LTA DataMall key is needed in `LTA_DATAMALL_KEY`. DataMall
serves passenger-volume months for three months only, and live feeds cannot be replayed, so
the derived tables the results depend on are committed in `data/processed/`:
`internal_od_202607_202608.csv.gz` (Yishun OD), `calibration.json`, `calibration_pm_peak.json`
and `gps_check.json`.

| # | Dataset | Provider | Access | Licence | What we use | Known limitations |
|---|---|---|---|---|---|---|
| 1 | Passenger Volume by Origin Destination Bus Stops, Jul, Aug and Sep 2026 (`PV/ODBus`) | LTA DataMall | API with key → monthly zip | Singapore Open Data Licence v1.0 | Average-weekday rides between every pair of Yishun stops by hour: **the demand** (July + August, full school-term months; September as a check) | Monthly aggregate by hour of tap-in; stages, not linked journeys; no day-to-day variation; September contains a school-holiday week |
| 2 | Passenger Volume by Bus Stops (`PV/Bus`) | LTA DataMall | API with key | SODL v1.0 | Cross-check of stop totals | Same aggregation |
| 3 | Bus Stops, Bus Services, Bus Routes | LTA DataMall | API with key, paged | SODL v1.0 | Stop locations, route stop sequences and distances, first/last buses, headway ranges per time band | Headways are published ranges, not timetables |
| 4 | Bus Arrival v3, live, Thu 15 Oct 2026, 10:06–14:57 and 17:30–19:30 SGT | LTA DataMall | API with key, polled every 90 s at the 151 stops coded 59xxx | SODL v1.0 | Calibration of running time, signal delay and dwell (10:00–12:59); headway regularity; GPS check of observed bus movement; evening-peak calibration; deck-type mix | Arrival times are LTA estimates; GPS position only for monitored buses; one weekday; the morning peak was not collected |
| 5 | Traffic Speed Bands v4, 15-min snapshots, same day | LTA DataMall | API with key | SODL v1.0 | Third check of the evening-peak slowdown on Yishun's roads | Speed *bands* from probe vehicles, not speeds |
| 7 | HDB Property Information | HDB via data.gov.sg (`d_17f5382f26140b1fdae0ba2ef6239d2f`) | Open download | SODL v1.0 | Storeys, completion year, dwelling units for 793 Yishun block records | No coordinates (joined to footprints by block number) |
| 8 | HDB Existing Building | HDB via data.gov.sg (`d_16b157c52ed637edd6ba1232e026258d`) | Open download | SODL v1.0 | Block footprints for the 3D view | No heights |
| 9 | Master Plan 2019 Planning Area / Subzone boundaries (No Sea) | URA via data.gov.sg (`d_4765db0e87b9c86336792efe8a1f7a66`, `d_8594ae9ff96d0c708bc2af633048edfb`) | Open download | SODL v1.0 | Study area; subzones | 2019 vintage |
| 10 | Master Plan 2019 Land Use | URA via data.gov.sg (`d_90d86daa5bfaa371668b84fa5f01424f`) | Open download (174 MB) | SODL v1.0 | Water, parks, road reserves on the base map | Plan, not as-built |
| 11 | Census 2020: residents by planning area / subzone, age, sex | SingStat via data.gov.sg (`d_d95ae740c0f8961a0b10435836660ce0`) | Open download | SODL v1.0 | Age profile (Yishun 65+: 13.0 % in 2020) | 2020 vintage |
| 12 | OpenStreetMap extract (Overpass, bbox 1.390–1.452 N, 103.805–103.875 E) | OSM contributors | Overpass mirror | ODbL 1.0 | Road graph, signals, buildings outside HDB, rail | Community data; checked against LTA route distances |

Secondary sources used for two approximate figures: bus capacities of about 90 riders for a
single-deck and 120–133 for a double-deck bus (Vulcan Post, 2020; Land Transport Guru vehicle
profiles), used only for the "places" comparison.

## Checked and not used

- **Geospatial Whole Island layers** (road crossings, humps, silver and school zones, kerb
  lines). Downloaded during exploration; no model or output uses them, so `make data` no
  longer fetches them (`python -m yishun.fetch_lta geo` does).
- **LTA Traffic Count** (static download).
  - Contents: classified turning movements at 1,406 sites in 15-minute intervals, from
    one-day surveys between April 2017 and May 2024. Yishun has 60 workbooks at 31 sites,
    the latest from January 2024.
  - Why not used: this project does not model general traffic. For a private-car
    microsimulation the data would be too sparse and too old.
- **Traffic signal timing plans.** On request only, under an NDA. Not needed.
- **Historical crash locations.** No open location-level dataset exists. The SPF statistics
  are national.
- **LTA Traffic Flow** (hourly link volumes, 07:00–09:00, May 2026).
  - Downloaded to test whether the shuttle fleet's added vehicle flow could be compared with
    measured traffic.
  - Inside the Yishun bounding box it covers only 5 expressway and slip-road links (TPE, Yio
    Chu Kang Road) and no estate roads, so that comparison is not possible with open data.

## Licence notes

- **Singapore Open Data Licence v1.0.** Permits copying, adaptation and redistribution of the
  datasets and derived works, with attribution.
  - LTA's general website terms are more restrictive. The DataMall API terms place the API
    datasets under the SODL.
  - For that reason this repository commits only **derived** outputs (`data/processed`,
    `web/public/data`), never raw LTA files.
- **OpenStreetMap.** Derived map data is © OpenStreetMap contributors under ODbL 1.0.
