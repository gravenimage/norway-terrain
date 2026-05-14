# Client Regression Checklist

Run before merging client refactors:

~~~powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
~~~

Manual browser checks:

- Page loads `viewer.html` with no unexpected console errors.
- Terrain renders and tile/cache counters increase.
- Exaggeration, SSE, segment, drape, building range, canopy range, and canopy LOD controls work.
- Roads, kommune boundaries, buildings, forest/trees, bedrock, quaternary, faults, and contours toggle correctly.
- Geology blend and contour opacity controls update labels and visuals.
- Camera position persists after refresh.
- Click-to-identify shows bedrock/quaternary information when rasters are loaded.
- Visual output matches the stored Playwright baselines within threshold.
