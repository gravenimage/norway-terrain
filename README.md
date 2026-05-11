# Rogaland 3D Terrain

A browser-based, real-time 3D renderer of the topography of Rogaland in
south-western Norway, built on a 10-metre digital elevation model from
Kartverket plus OpenStreetMap roads/buildings/boundaries and ESA WorldCover
forest+water layers.

![Rogaland 10 m DTM preview](rogaland_10m_preview.png)

## Quick start

You need:

1. **Python 3.10+** with `pip` (only used once, to glue split files together).
2. **A modern web browser** (Chrome / Edge / Firefox / Safari).
3. **A way to serve static files locally** — Python ships with one.

Steps:

```bash
git clone https://github.com/gravenimage/norway-terrain.git
cd norway-terrain
python reconstitute.py            # reassembles the two big data files
python -m http.server 8000        # serve this folder
```

Then open <http://localhost:8000/viewer.html> in your browser.

If you only want the preview page (lower-res still images), open
<http://localhost:8000/index.html> instead.

> **Why the `reconstitute.py` step?**
> GitHub blocks single files larger than 100 MB. The 10 m DEM
> (`rogaland_10m.tif`, ~700 MB) and the forest canopy mesh (`canopy.bin`,
> ~110 MB) are stored under `data_parts/` as chunks under 100 MB each.
> `reconstitute.py` glues them back together. It is safe to re-run.

## What you'll see

Use the mouse to fly around:

- **Left-drag**: orbit
- **Right-drag**: pan
- **Wheel**: zoom

Sliders and toggles in the top-right control panel let you adjust vertical
exaggeration, terrain detail (screen-space error and tessellation), and
which layers are visible (roads, kommune boundaries, buildings, forest).
Distance sliders fine-tune the LOD switches for buildings and forest.

## What's in here

| File / folder | What it is |
| --- | --- |
| `viewer.html` | The renderer. Three.js + custom shaders, no build step. |
| `index.html` | A simpler static preview page (PNG renders of the DEM). |
| `data_parts/` | Chunked source data files (joined by `reconstitute.py`). |
| `tiles/` | Mapbox-style terrain-RGB pyramid of the DEM (PNG tiles). |
| `forest.bin` | Per-tree seed records (TRE1 binary). |
| `buildings.bin` | OSM building footprints + heights (BLD1 binary). |
| `osm.bin` | Major roads + kommune boundaries (OSM2 binary). |
| `water.bin` | Inland water-body mesh (WATR binary). |
| `*.py` | Offline data-pipeline scripts (you don't need to run these). |
| `SPEC.md` | Full feature & data-source specification (read this if you want to reimplement the renderer in another stack). |

## Regenerating the data files (advanced)

You don't need to do this — the binaries are committed. But if you ever
want to rebuild from raw sources, the scripts in this folder do that:

- `densify.py` — downloads the 10 m DEM from Kartverket and mosaics it.
- `pyramid.py` — slices the DEM into the terrain-RGB PNG tile pyramid.
- `osm_fetch.py` — pulls major roads + kommune boundaries from Overpass.
- `buildings_fetch.py` — pulls building footprints from Overpass in tiles.
- `forest_polys.py` — builds canopy mesh + per-tree records from ESA
  WorldCover class 10.
- `water_polys.py` — builds the inland-water mesh from WorldCover class 80.

Each script requires `numpy`, `rasterio`, `requests` and `shapely`. The
recommended invocation pattern is:

```bash
uv run --with numpy --with rasterio --with requests --with shapely python <script>.py
```

(Or set up a virtualenv yourself.)

## Data sources & licences

- **DEM**: Kartverket "NHM_DTM_TOPOBATHY_25833" (Norwegian National Height
  Model, 1 m → downsampled to 10 m), <https://hoydedata.no>.
  Open data under [Kartverket open data
  terms](https://www.kartverket.no/api-og-data/vilkar-for-bruk).
- **Roads, buildings, kommune boundaries**: OpenStreetMap contributors,
  fetched via the public Overpass API. © OpenStreetMap contributors,
  [ODbL](https://www.openstreetmap.org/copyright).
- **Forest + water cover**: ESA WorldCover v200 2021 product (10 m global
  land cover). © ESA WorldCover project, CC BY 4.0.

The rendering code in this repository is otherwise free to copy and
adapt. See `SPEC.md` for the full visual / aesthetic specification.
