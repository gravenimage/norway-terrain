# Road cuts and dynamic corridor regrid design

## Problem

The current road renderer paints roads in the terrain fragment shader by measuring
world-XY distance to OSM segments. This keeps roads perfectly aligned with the
terrain, but it cannot change terrain geometry. On side slopes, roads inherit the
hill cross-slope and look like tilted paint rather than cut roadbeds.

The desired result is a road surface that is flat across its width, follows the
terrain longitudinally, sits above other overlays, and removes trees from the
road footprint. Offline pipeline changes are allowed, and the first-class target
is a true local terrain cut/regrid rather than a visual-only ribbon.

## Chosen approach

Use a hybrid road-cut system:

1. Generate a new offline `roadcuts.bin` asset with road topology, smoothed
   centreline elevations, per-side cut/fill bank widths, junction caps, bridge
   and tunnel flags, and a spatial index.
2. In the viewer, keep the existing terrain LOD mesh for ordinary terrain.
3. Near the camera, replace road footprints with generated corridor meshes. The
   terrain shader discards base terrain fragments inside active road-cut
   footprints, and the corridor mesh fills that hole with a locally regridded
   road/cut surface.
4. At far distance, do not try to geometrically cut coarse terrain vertices.
   Use a simplified static fallback, such as far road mask painting or simplified
   low-detail corridor strips, because the terrain vertex spacing is too coarse
   to represent 5-10 m road cuts.

This is not full constrained triangulation of every visible terrain tile. It is a
targeted local regrid of the road corridor, which avoids the need for a new
triangulation dependency and avoids fighting the existing shared terrain mesh
pool.

## Alternatives considered

### Static full-region road-cut raster

A full static raster could store road mask, target road elevation, and blend
weights for the whole DEM. The terrain shader would sample that raster and blend
terrain vertices toward the road plane.

This is not the primary design because the region is too large for a single
high-resolution texture, and the existing terrain vertices are too sparse at far
LOD to represent narrow roads geometrically. A sparse tile or pyramid variant is
still useful for masks or far visual fallback, but not for close-up road cuts.

### Dynamic full-tile retriangulation

Visible terrain tiles could be rebuilt with constrained road edges and centreline
vertices inserted directly into each tile mesh.

This is geometrically pure, but it is high-risk without a constrained
triangulation library. It would also complicate tile borders, LOD transitions,
mesh pooling, cache invalidation, and cracks between tiles. The corridor-regrid
approach provides the same local visual result inside the road footprint with a
fixed strip topology.

### Flat road ribbon without terrain discard

A separate flat ribbon mesh can make the asphalt itself horizontal, but the
underlying terrain still exists and can poke through or z-fight on banks and
edges. This was rejected as the primary solution because it is not a true terrain
cut and is likely to fail on steep side slopes.

## Offline data pipeline

Add a dedicated road-cut pipeline step, either as a new script or as an extension
of `osm_fetch.py`, that emits `roadcuts.bin`. Keep `osm.bin` for kommune lines
and any existing far overlay compatibility.

The road-cut asset should preserve road polylines instead of flattening them into
independent line segments. For each road, store:

- stable road id and class
- class-derived road half-width
- ordered station coordinates in centred world metres
- cumulative distance along the road
- original DEM elevation per station
- smoothed road elevation per station
- per-side cut/fill bank width
- bridge, tunnel, and layer flags
- references to junction/cap geometry where applicable

The offline process should build a road graph so connected junction nodes share a
single solved elevation. Each road's centreline elevation should be smoothed with
grade and deviation limits, not with an unconstrained moving average. The goal is
to remove DEM noise and cross-slope artifacts without making roads visibly float
over real crests or sink through valleys.

Bank widths should scale from the local height difference between the flat road
surface and sampled terrain on each side. A fixed bank width would produce
near-vertical cliffs on steep hillsides. Use cut/fill batter ratios and caps so
the footprint grows on steep slopes but remains bounded.

Bridges and tunnels must be tagged in `roadcuts.bin`. Bridges should not cut the
terrain underneath; they need a separate deck treatment or can be skipped in the
first cut pass. Tunnels should not cut the surface except at portals, which can
be deferred.

For trees, the robust fix is offline subtraction of road-cut footprints from
future forest/tree generation. Runtime shader masks can hide existing committed
assets as a stopgap, but durable tree placement should not rely on fragment
discard.

## Runtime architecture

Load `roadcuts.bin` after terrain metadata and expose road-cut state through
shared uniform objects, following the existing `roadUniforms` pattern.

Maintain a road spatial index in JS so the renderer can find road corridors near
the camera and near visible high-detail terrain. Corridor meshes should be
cached by road id and station range, not by terrain tile, so zooming and LOD
switches do not constantly rebuild them.

Each generated corridor mesh is a strip:

- rows follow centreline stations
- columns span the local cross-section
- centre/edge columns form the flat asphalt surface at smoothed road Z
- bank columns blend from road Z to sampled terrain Z
- outer columns meet the terrain outside the discarded footprint

The terrain fragment shader should use the road-cut footprint mask to discard
base terrain where a close corridor mesh is active. This avoids the z-fighting
that would occur if the corridor were merely depth-biased over the original
terrain. The corridor mesh must fully cover the discarded area, including banks,
so there are no holes.

The existing roads checkbox should gate all road-cut behavior:

- hide corridor meshes
- disable terrain discard
- disable road mask/overlay
- disable water/canopy road masking

If roads are subtracted from generated tree assets offline, toggling roads off
will not restore those trees without alternate assets or a reload. That tradeoff
should be explicit in the UI or documentation if it becomes user-visible.

## Overlay interactions

Roads must visually win over water and canopy. Water and canopy shaders should
sample the same road-cut mask and discard or alpha out inside road footprints
when roads are enabled. This is preferable to relying only on render order,
especially for water crossings.

Buildings, amenities, civic boundaries, and faults are lower priority. They may
continue to render over or near roads unless a specific conflict is observed.

## Junctions and crossings

Independent road strips will produce gaps, overlaps, and mismatched elevations at
junctions. The offline pipeline should emit cap polygons for T-junctions,
crossroads, roundabouts, and tight ramps. Junction polygons should use one shared
node elevation and should clip or cover overlapping strip ends.

Bridge and tunnel metadata should be carried from OSM tags early. Cutting a
terrain trench under a bridge would be more visually wrong than leaving that road
uncut for the first pass.

## Far-distance fallback

The requested fallback should be static, but not necessarily a static geometric
terrain cut. At far LOD, terrain vertices are too sparse to form narrow roadbeds.
The fallback should therefore prioritize visual continuity:

- keep or adapt the existing shader road mask for far road color
- optionally use simplified low-detail corridor strips without detailed banks
- fade from far fallback to close corridor cuts over a distance band

The transition should avoid showing both tilted road paint and close cut geometry
at the same time. Close corridor cuts should own the road footprint when active.

## Rollout plan

Start with a focused prototype on one known steep sidehill road and one nearby
junction. Prove the core loop before scaling:

1. Generate or hand-load a small road-cut subset.
2. Build one corridor mesh with flat cross-sections and bank columns.
3. Add terrain discard for that footprint.
4. Verify no z-fighting, no visible holes, and acceptable road/cut appearance at
   high vertical exaggeration.
5. Add junction caps, bridge/tunnel skipping, water/canopy masking, then expand
   to all roads.

## Validation

Validation should be visual and targeted:

- inspect steep sidehill roads at close distance
- compare roads on/off with high vertical exaggeration
- check T-junctions, roundabouts, bridges, tunnels, and water crossings
- confirm canopy/water do not overdraw active roads
- confirm tree placement is absent from road footprints after regeneration
- compare FPS and visible mesh counts with roads enabled and disabled

No new automated test framework is required. A temporary browser screenshot
harness is acceptable for spot comparisons if needed.
