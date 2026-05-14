# Client Architecture

The browser client starts in `viewer.html`, imports `src/client/init.js`, and initializes browser-native ES modules under `src/client/`.

## Module ownership

- `core/`: constants, binary helpers, coordinate transforms, and UI-controlled app state.
- `terrain/`: tile pyramid math, height texture contracts, tile cache, mesh pool, and LOD traversal.
- `rendering/`: scene setup, camera persistence, frustum updates, material factories, render loop, and compass.
- `shaders/`: shader source strings moved from the original viewer without formula changes.
- `overlays/`: roads, geology, contours, faults, and click-to-identify.
- `features/`: buildings, forest/canopy, water, amenities, road-trip camera, place-name labels, and geometry builders.
- `ui/`: DOM controls and HUD updates.

## Preserved contracts

- Height texture sampling keeps the original Y-flip behavior.
- Geology raster sampling keeps the original no-flip behavior.
- Shared uniforms are passed by reference.
- Terrain meshes are recycled each frame before quadtree traversal.
- Render-loop order remains controls, recycle, frustum, terrain, feature culling, cache eviction, render, compass.
- UI controls preserve the original labels, ranges, and side effects.
