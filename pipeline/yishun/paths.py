"""Filesystem locations used across the pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"
PROCESSED = ROOT / "data" / "processed"
WEB_DATA = ROOT / "web" / "public" / "data"

for _p in (INTERIM, PROCESSED):
    _p.mkdir(parents=True, exist_ok=True)

# Projected CRS for every metric computation: SVY21 / Singapore TM (metres).
CRS_METRIC = 3414
CRS_WGS84 = 4326
