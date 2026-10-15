# Driverless Yishun: reproducible pipeline.
# Requires Python 3.12 and an LTA DataMall key in LTA_DATAMALL_KEY (free registration).
PY ?= python
RUN = cd pipeline && $(PY) -m

.PHONY: setup data live calibrate gps-check calibrate-peak experiments sensitivity results web test \
        reproduce-core-results serve clean-cache

setup:            ## create the environment
	uv venv .venv --python 3.12 && . .venv/bin/activate && uv pip install -r requirements.txt

data:             ## download raw inputs (LTA DataMall, data.gov.sg, OpenStreetMap)
	$(RUN) yishun.fetch_lta all
	$(RUN) yishun.fetch_lta pv-od 202607
	$(RUN) yishun.fetch_lta pv-od 202608
	$(RUN) yishun.fetch_datagov
	$(RUN) yishun.fetch_osm

live:             ## collect 2 hours of live bus arrivals + speed bands (run at the hours you want)
	$(RUN) yishun.collect_live --minutes 118 --interval 90 & pid=$$!; \
	$(RUN) yishun.collect_speeds --minutes 118 --interval 900; s=$$?; wait $$pid && exit $$s

calibrate:        ## refit road speeds, signal delay, bus dwell and headway regularity on live logs
	$(RUN) yishun.calibrate

gps-check:        ## compare the calibrated model with observed bus GPS movement
	$(RUN) yishun.gps_check

calibrate-peak:   ## evening-peak calibration (17:00-19:59 SGT), used by one sensitivity case
	$(RUN) yishun.calibrate --hours 17-19 --out calibration_pm_peak.json

experiments:      ## fixed-fleet days, hour-window fleet requirements, kerb capacity
	$(RUN) yishun.experiments frontier 3
	$(RUN) yishun.experiments ext 3
	$(RUN) yishun.experiments hourly 3
	$(RUN) yishun.experiments kerb 3

sensitivity:      ## all-day parity fleet under alternative assumptions
	$(RUN) yishun.sensitivity

results:          ## results.json, calibration points, animation data for the page
	$(RUN) yishun.export_web
	$(RUN) yishun.export_results
	$(RUN) yishun.export_anim_main

web: results      ## build the static site into web/dist
	$(PY) web/build.py

test:
	$(PY) -m pytest -q

# Everything after `make data`. The live logs behind the calibration (15 Oct 2026) cannot be
# downloaded again, so this uses the committed data/processed/calibration.json, gps_check.json
# and calibration_pm_peak.json; run `make live calibrate gps-check calibrate-peak` to refit.
reproduce-core-results: experiments sensitivity results test

serve:
	cd web/dist && $(PY) -m http.server 8000

clean-cache:
	rm -f data/interim/*.pkl data/interim/*.parquet
