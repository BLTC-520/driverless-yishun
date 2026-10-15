# Driverless Yishun: reproducible pipeline.
# Requires Python 3.12 and an LTA DataMall key in LTA_DATAMALL_KEY (free registration).
PY ?= python
RUN = cd pipeline && $(PY) -m

.PHONY: setup data live calibrate experiments sensitivity results web test reproduce-core-results serve clean-cache

setup:            ## create the environment
	uv venv .venv --python 3.12 && . .venv/bin/activate && uv pip install -r requirements.txt

data:             ## download raw inputs (LTA DataMall, data.gov.sg, OpenStreetMap)
	$(RUN) yishun.fetch_lta all
	$(RUN) yishun.fetch_datagov
	$(RUN) yishun.fetch_osm

live:             ## collect 2 hours of live bus arrivals + speed bands (run at the hours you want)
	$(RUN) yishun.collect_live --minutes 118 --interval 90 & $(RUN) yishun.collect_speeds --minutes 118 --interval 900; wait

calibrate:        ## fit road speeds, signal delay, bus dwell and headway regularity on live logs
	$(RUN) yishun.calibrate

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

reproduce-core-results: calibrate experiments sensitivity results test   ## everything after data download

serve:
	cd web/dist && $(PY) -m http.server 8000

clean-cache:
	rm -f data/interim/*.pkl data/interim/*.parquet
