# Rogaland 3D Terrain

A browser-based, real-time 3D renderer of the topography of Rogaland in
south-western Norway, built on a 10-metre digital elevation model from
Kartverket plus OpenStreetMap roads/buildings/boundaries and ESA WorldCover
forest+water layers.

![Rogaland 10 m DTM preview](rogaland_10m_preview.png)

## Quick start

You need:

1. **[uv](https://docs.astral.sh/uv/)** (fast Python runner — handles Python and dependencies for you).
2. **A modern web browser** (Chrome / Edge / Firefox / Safari).

Then:

```bash
git clone https://github.com/gravenimage/norway-terrain.git
cd norway-terrain
uv run serve.py
```

That's it. The script will:
1. Reconstitute the two big data files from `data_parts/` if needed (a few seconds, only happens the first time).
2. Start a local web server on <http://localhost:8000/> (or the next free port if 8000 is busy — the actual URL is printed on startup).
3. Open the viewer in your default browser automatically.

Press **Ctrl+C** in the terminal to stop the server.

### Don't have `uv`?

`uv` is a single-binary install — see <https://docs.astral.sh/uv/getting-started/installation/>.
On Windows / macOS / Linux it's one shell command.

If you really don't want `uv`, plain Python 3.10+ works too:

```bash
python serve.py
```

> **What's the `data_parts/` thing?**
> GitHub blocks single files larger than 100 MB. The 10 m DEM
> (`rogaland_10m.tif`, ~700 MB) and the forest canopy mesh (`canopy.bin`,
> ~110 MB) are stored under `data_parts/` as chunks under 100 MB each.
> `serve.py` (and the standalone `reconstitute.py`) glues them back together
> on first run. Re-running is safe and a no-op.

## What you'll see

Use the mouse to fly around:

- **Left-drag**: orbit
- **Right-drag**: pan
- **Wheel**: zoom

Sliders and toggles in the top-right control panel let you adjust vertical
exaggeration, terrain detail (screen-space error and tessellation), and
which layers are visible (roads, kommune boundaries, buildings, forest).
Distance sliders fine-tune the LOD switches for buildings and forest.

The **Geology** subpanel (top-right) toggles three additional layers — Bedrock,
Quaternary deposits, and Faults — sourced from NGU. Use the blend slider to fade
the geological fills against the natural terrain palette. With any geology layer
visible, click anywhere on the ground to see the rock type and surface deposit
at that point.

## What's in here

| File / folder | What it is |
| --- | --- |
| `viewer.html` | The renderer. Three.js + custom shaders, no build step. |
| `index.html` | A simpler static preview page (PNG renders of the DEM). |
| `serve.py` | One-shot launcher: reconstitutes data + starts the local web server. |
| `reconstitute.py` | Standalone version of just the data-reassembly step. |
| `data_parts/` | Chunked source data files (joined by `reconstitute.py`). |
| `tiles/` | Mapbox-style terrain-RGB pyramid of the DEM (PNG tiles). |
| `forest.bin` | Per-tree seed records (TRE1 binary). |
| `buildings.bin` | OSM building footprints + heights (BLD1 binary). |
| `osm.bin` | Major roads + kommune boundaries (OSM2 binary). |
| `water.bin` | Inland water-body mesh (WATR binary). |
| `bedrock_raster.bin` + `bedrock_palette.json` | NGU bedrock raster overlay + palette (BRR1 binary, 50 m px). |
| `quaternary_raster.bin` + `quaternary_palette.json` | NGU Quaternary deposits raster overlay + palette (QRR1 binary, 50 m px). |
| `faults.bin` | NGU structural fault lines (FLT1 binary). |
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
- `geology_fetch.py` — pulls NGU bedrock + Quaternary + faults via WFS for the
  Rogaland bbox. Slow (tens of minutes) on first run; caches per-tile responses
  under `geology_cache/`. Requires `pyproj` in addition to the deps above.

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
- **Geology**: NGU (Norges geologiske undersøkelse), bedrock + Quaternary
  + structural data via the public WFS services. © NGU,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The rendering code in this repository is otherwise free to copy and
adapt. See `SPEC.md` for the full visual / aesthetic specification.
