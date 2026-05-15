/**
 * @file Owns viewer bootstrapping: metadata loading, scene construction, system wiring, UI attachment, and render-loop startup. Shared uniforms and system references are intentionally passed by reference so controls can mutate live rendering state.
 */

import {
  CAMERA_STORAGE_KEY,
  DEFAULT_BUILDING_RANGE_KM,
  DEFAULT_CANOPY_LOD_KM,
  DEFAULT_CANOPY_RANGE_KM,
  DEFAULT_DRAPE_OFFSET_METRES, // imported for future drape default extraction; no matching JS variable yet
  DEFAULT_EXAGGERATION,
  DEFAULT_SEGMENTS,
  DEFAULT_SSE_PX,
  ELEV_MAX as DEFAULT_ELEV_MAX,
  TREE_CANOPY_FADE_WIDTH_METRES,
} from './core/constants.js';
import { restoreCamera, saveCamera } from './rendering/camera-persistence.js';
import { createCompass } from './rendering/compass.js';
import { createViewerScene } from './rendering/scene.js';
import { createAppState } from './core/app-state.js';
import { createWorldTransform } from './core/coordinates.js';
import { createTileCache } from './terrain/tile-cache.js';
import { createTerrainMeshPool } from './terrain/terrain-mesh-pool.js';
import { makeTileEdgeGeometry } from './terrain/tile-edge-geometry.js';
import { createFrustumCuller } from './rendering/frustum-culler.js';
import { createTerrainLodRenderer } from './terrain/terrain-lod.js';
import { startRenderLoop } from './rendering/render-loop.js';
import {
  createBuildingMaterial,
  createTerrainMaterial,
  createTileEdgeMaterial,
  createWaterMaterial,
} from './rendering/material-factory.js';
import { createAmenitiesSystem } from './features/amenities.js';
import { createBuildingSystem } from './features/buildings.js';
import { createForestSystem } from './features/forest.js';
import { createWaterSystem } from './features/water.js';
import { createFaultSystem } from './overlays/faults.js';
import { createGeologySystem } from './overlays/geology.js';
import { attachIdentifyHandlers } from './overlays/identify.js';
import { createRoadSystem } from './overlays/roads.js';
import { attachControls } from './ui/controls.js';
import { createPlacementObstacles } from './placement/obstacles.js';
import { createRoadTripSystem } from './features/roadtrip.js';
import { attachRoadTripPanel } from './ui/roadtrip-panel.js';
import { createLabelSystem } from './features/labels.js';
import {
  aliasRoadUniforms,
  createSharedContourUniforms,
  createSharedGeologyUniforms,
  createSharedRoadUniforms,
} from './rendering/uniform-bundles.js';


/**
 * Renders a fixed-position overlay reporting fatal initialization errors so the page never silently goes blank when bootstrap fails (e.g. missing tiles/meta.json). Idempotent: a second call replaces the prior message.
 */
function showBootError(err) {
  try {
    const existing = document.getElementById('__viewer-boot-error');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = '__viewer-boot-error';
    div.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);color:#fff;font:14px/1.4 system-ui,sans-serif;z-index:99999;padding:24px;text-align:center;';
    const msg = (err && (err.message || String(err))) || 'unknown error';
    div.innerHTML = `<div style="max-width:640px"><h2 style="margin:0 0 12px;font-size:18px;color:#f88">Viewer failed to start</h2><pre style="white-space:pre-wrap;text-align:left;background:#111;padding:12px;border-radius:4px;overflow:auto;max-height:50vh">${msg.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</pre><p style="margin:12px 0 0;color:#aaa">Common cause: <code>tiles/meta.json</code> is missing. Build the tile set or check the server root.</p></div>`;
    document.body.appendChild(div);
  } catch { /* nothing more we can do */ }
}

/**
 * Initializes the complete client viewer from externally supplied Three.js dependencies. It owns startup order, fetches dataset metadata before constructing systems, and starts long-lived fire-and-forget loaders/rendering without returning an application object. Any failure during bootstrap surfaces through showBootError so the page does not silently render blank.
 */
export async function initializeViewer(deps) {
  try {
    return await _initializeViewerImpl(deps);
  } catch (err) {
    console.error('[viewer] initialization failed', err);
    showBootError(err);
    throw err;
  }
}

/**
 * Internal bootstrap body. Extracted so the outer initializeViewer can wrap it in a single try/catch without indenting the entire module.
 */
async function _initializeViewerImpl({ THREE, MapControls }) {
  const metaResp = await fetch('tiles/meta.json');
  if (!metaResp.ok) {
    throw new Error(`tiles/meta.json fetch failed: HTTP ${metaResp.status} ${metaResp.statusText}`);
  }
  const meta = await metaResp.json();
  const world = createWorldTransform(meta);
  const ROOT_X = world.rootX;
  const ROOT_Y = world.rootY;
  const ROOT_SIZE = world.rootSize;
  const MAX_Z = meta.maxZ;
  const SRC = meta.src;
  const ELEV_MAX = meta.elevMax || DEFAULT_ELEV_MAX;
  const TILE_PX = meta.tileSize;
  const CENTER_X = world.centerX;
  const CENTER_Y = world.centerY;
  
  const viewerScene = createViewerScene({ THREE, MapControls, canvas: document.querySelector('canvas'), meta });
  const { scene, camera, controls, renderer, groups } = viewerScene;
  const {
    roadsGroup,
    townsGroup,
    buildingsGroup,
    amenitiesGroup,
    treesGroup,
    canopyGroup,
    faultsGroup,
  } = groups;
  const { near: FOG_NEAR, far: FOG_FAR, color: FOG_COLOR } = viewerScene.fog;
  const SUN = viewerScene.sun;
  // Dev-only debug handle: exposes the live scene graph to the browser console
  // and to e2e tests. Not part of any public API — do not depend on it from
  // production code paths.
  window.__viewer = { camera, controls, renderer, scene };
  
  // ---------- persist camera + target across reloads ----------
  const CAM_STORAGE_KEY = CAMERA_STORAGE_KEY;
  restoreCamera({ camera, controls, storageKey: CAM_STORAGE_KEY });
  
  let _camSaveTimer = 0;
  /**
   * Persists the current camera and target using the legacy storage shape shared with camera-persistence tests.
   */
  function _saveCameraNow(){
    saveCamera({ camera, controls, storageKey: CAM_STORAGE_KEY });
  }
  /**
   * Throttles camera saves during interaction while preserving a final beforeunload save path.
   */
  controls.addEventListener('change', () => {
    if (_camSaveTimer) return;
    _camSaveTimer = setTimeout(() => { _camSaveTimer = 0; _saveCameraNow(); }, 250);
  });
  addEventListener('beforeunload', () => {
    if (_camSaveTimer) { clearTimeout(_camSaveTimer); _camSaveTimer = 0; }
    _saveCameraNow();
  });
  
  // ---------- OSM overlay (roads + kommune boundaries) ----------
  const overlayUniforms = {
    uExag:   { value: 1.4 },
    uOffset: { value: 12.0 },
  };
  
  // ---------- Buildings (stylized Norwegian houses + apartments) ----------
  // Placement obstacle service must be built before any feature system that depends on it so the
  // ready-promises are observable by all consumers. Roads and buildings publish into it, forest
  // trees read from it during their async generation.
  const placementObstacles = createPlacementObstacles();
  const buildingUniforms = {
    uExag:      { value: 1.4 },
    uExtraLift: { value: 0.5 },
    uSun:       { value: SUN.clone() },
    uFogNear:   { value: FOG_NEAR },
    uFogFar:    { value: FOG_FAR },
    uFogColor:  { value: FOG_COLOR },
    uFadeNear:  { value: 18000 },
    uFadeFar:   { value: 22000 },
  };
  let BLD_RANGE = DEFAULT_BUILDING_RANGE_KM * 1000;
  const buildingMaterial = createBuildingMaterial(buildingUniforms);
  const buildingSystem = createBuildingSystem({
    THREE,
    scene,
    buildingsGroup,
    buildingUniforms,
    buildingMaterial,
    elevationMax: ELEV_MAX,
    obstacles: placementObstacles,
  });
  buildingSystem.load();
  
  // ---------- Civic amenities (pitches, parks, playgrounds, props) ----------
  const amenityAreaUniforms = {
    uExag:      { value: 1.4 },
    uExtraLift: { value: 1.2 },
    uSun:       { value: SUN.clone() },
    uFogNear:   { value: FOG_NEAR },
    uFogFar:    { value: FOG_FAR },
    uFogColor:  { value: FOG_COLOR },
    uFadeNear:  { value: 18000 },
    uFadeFar:   { value: 22000 },
  };
  
  const amenityPropUniforms = {
    uExag:     { value: 1.4 },
    uSun:      { value: SUN.clone() },
    uFogNear:  { value: FOG_NEAR },
    uFogFar:   { value: FOG_FAR },
    uFogColor: { value: FOG_COLOR },
    uFadeNear: { value: 3500 },
    uFadeFar:  { value: 5000 },
  };
  const amenitiesSystem = createAmenitiesSystem({
    THREE,
    scene,
    amenitiesGroup,
    amenityAreaUniforms,
    amenityPropUniforms,
  });
  amenitiesSystem.load();
  
  // Shared road overlay uniforms. Roads are NOT drawn as separate meshes;
  // instead, the terrain fragment shader looks up the nearest road segment
  // for each pixel via a coarse spatial grid (built from osm.bin at load
  // time) and tints the terrain colour where the pixel falls within road
  // half-width of a segment. See buildRoadOverlay() below. The same uniforms
  // are shared by reference into water/canopy/tree materials so those shaders
  // can discard fragments inside the road footprint and stop occluding the
  // painted road.
  const roadUniforms = createSharedRoadUniforms(THREE);
  
  // ---------- Forest (low-poly conifers / birches at OSM forest cover) ----------
  const treeUniforms = {
    uExag:      { value: 1.4 },
    uExtraLift: { value: 0.4 },
    uSun:       { value: SUN.clone() },
    uFogNear:   { value: FOG_NEAR },
    uFogFar:    { value: FOG_FAR },
    uFogColor:  { value: FOG_COLOR },
    uFadeNear:  { value: 1200 },
    uFadeFar:   { value: 1800 },
    // road-mask references (shared-by-reference) so trees discard road footprints
    ...aliasRoadUniforms(roadUniforms),
  };
  let CANOPY_LOD_LO = DEFAULT_CANOPY_LOD_KM * 1000 - TREE_CANOPY_FADE_WIDTH_METRES;
  let CANOPY_LOD_HI = DEFAULT_CANOPY_LOD_KM * 1000 + TREE_CANOPY_FADE_WIDTH_METRES;
  let CANOPY_RANGE  = DEFAULT_CANOPY_RANGE_KM * 1000;
  
  const canopyUniforms = {
    uExag:      { value: 1.4 },
    uExtraLift: { value: 0.4 },
    uSun:       { value: SUN.clone() },
    uFogNear:   { value: FOG_NEAR },
    uFogFar:    { value: FOG_FAR },
    uFogColor:  { value: FOG_COLOR },
    uFadeNear:  { value: CANOPY_LOD_LO },
    uFadeFar:   { value: CANOPY_LOD_HI },
    uRangeNear: { value: CANOPY_RANGE - 2000 },
    uRangeFar:  { value: CANOPY_RANGE },
    // road-mask references (shared-by-reference) so canopy discards road footprints
    ...aliasRoadUniforms(roadUniforms),
  };
  const forestSystem = createForestSystem({
    THREE,
    scene,
    treesGroup,
    canopyGroup,
    treeUniforms,
    canopyUniforms,
    elevationMax: ELEV_MAX,
    obstacles: placementObstacles,
  });
  forestSystem.loadCanopy();
  
  // ---------------- inland water bodies ----------------
  const waterUniforms = {
    uExag: { value: 1.4 },
    uSun:  { value: SUN.clone() },
    // road-mask references (shared-by-reference) so water discards road footprints
    ...aliasRoadUniforms(roadUniforms),
  };
  const waterMaterial = createWaterMaterial(waterUniforms);
  const waterSystem = createWaterSystem({ THREE, scene, waterUniforms, waterMaterial });
  waterSystem.load();
  forestSystem.loadTrees();
  // ---------------- end inland water -----------------
  
  
  const tileCache = createTileCache({ THREE, maxEntries: 400 });
  
  // ---------- shared geometry ----------
  const SEG = DEFAULT_SEGMENTS;
  const initialPlane = new THREE.PlaneGeometry(1, 1, SEG, SEG);
  
  // ---------- shader ----------
  // Shared geology overlay uniforms — all terrain materials get these
  // by reference, so toggling a value affects every tile mesh at once.
  const geoUniforms = createSharedGeologyUniforms(THREE);

  // Shared contour uniforms — same sharing pattern as geology.
  const contourUniforms = createSharedContourUniforms(THREE);
  
  /**
   * Creates one terrain material with per-tile uniforms plus shared overlay uniforms by reference. Overlay uniforms are mutated in place elsewhere so every material observes the same geology, contour, and road state.
   */
  function makeMaterial(){
    return createTerrainMaterial({
        uHeight:   { value: null },
        uOriginXY: { value: new THREE.Vector2() },
        uTileSize: { value: 1 },
        uExag:     { value: 1.4 },
        uElevMax:  { value: ELEV_MAX },
        uSun:      { value: SUN.clone() },
        uSeg:      { value: SEG },
        uUVScale:  { value: new THREE.Vector2(1,1) },
        uUVOffset: { value: new THREE.Vector2(0,0) },
        uFogNear:  { value: FOG_NEAR },
        uFogFar:   { value: FOG_FAR },
        uFogColor: { value: FOG_COLOR },
        // geology overlay (shared-by-reference; updated once per uniform):
        uBedTex:      geoUniforms.uBedTex,
        uBedPalette:  geoUniforms.uBedPalette,
        uBedShow:     geoUniforms.uBedShow,
        uBedPalN:     geoUniforms.uBedPalN,
        uQuatTex:     geoUniforms.uQuatTex,
        uQuatPalette: geoUniforms.uQuatPalette,
        uQuatShow:    geoUniforms.uQuatShow,
        uQuatPalN:    geoUniforms.uQuatPalN,
        uGeoBBox:     geoUniforms.uGeoBBox,
        uGeoOpacity:  geoUniforms.uGeoOpacity,
        // contour overlay (shared-by-reference):
        uContourShow:      contourUniforms.uContourShow,
        uContourInterval:  contourUniforms.uContourInterval,
        uContourBoldEvery: contourUniforms.uContourBoldEvery,
        uContourColor:     contourUniforms.uContourColor,
        uContourBoldColor: contourUniforms.uContourBoldColor,
        uContourOpacity:   contourUniforms.uContourOpacity,
        // road overlay (shared-by-reference):
        ...aliasRoadUniforms(roadUniforms),
    });
  }
  
  // ---------- mesh pool ----------
  const initialEdgeGeometry = makeTileEdgeGeometry(THREE, SEG);
  const terrainMeshPool = createTerrainMeshPool({
    THREE,
    scene,
    makeMaterial,
    initialGeometry: initialPlane,
    makeEdgeMaterial: (uniforms) => createTileEdgeMaterial(uniforms),
    edgeGeometry: initialEdgeGeometry,
  });
  
  // ---------- quadtree LOD ----------
  let SSE_PX = DEFAULT_SSE_PX;
  let EXAG = DEFAULT_EXAGGERATION;
  const roadSystem = createRoadSystem({
    THREE,
    scene,
    roadUniforms,
    overlayUniforms,
    roadsGroup,
    townsGroup,
    src: SRC,
    centerX: CENTER_X,
    centerY: CENTER_Y,
    obstacles: placementObstacles,
  });
  roadSystem.setExaggeration(EXAG);
  roadSystem.load();
  // ---------------- faults layer (FLT1) -----------------
  // ---------------- geology raster overlay (BRR1 / QRR1) -----------------
  const geologySystem = createGeologySystem({ THREE, geoUniforms, faultsGroup });
  geologySystem.loadBedrock();
  geologySystem.loadQuaternary();
  // ---------------- end geology raster overlay -----------------
  
  const faultSystem = createFaultSystem({
    THREE,
    scene,
    faultsGroup,
    /**
     * Supplies the live exaggeration value so fault geometry follows UI changes without rebuilding the system.
     */
    getExaggeration: () => EXAG,
  });
  faultSystem.load();
  // ---------------- end faults layer -----------------
  
  // ---------------- click-to-identify geology (raster lookup) -----------------
  const idPanel = document.createElement('div');
  idPanel.id = 'id-panel';
  idPanel.style.cssText = 'position:fixed;display:none;background:rgba(0,0,0,0.78);color:#cdd;padding:8px 22px 8px 10px;border:1px solid #555;border-radius:6px;font:12px system-ui;z-index:9999;max-width:260px';
  document.body.appendChild(idPanel);
  
  const idClose = document.createElement('button');
  idClose.type = 'button';
  idClose.setAttribute('aria-label', 'Close');
  idClose.textContent = '×';
  idClose.style.cssText = 'position:absolute;top:1px;right:3px;width:14px;height:14px;padding:0;line-height:12px;font-size:14px;background:transparent;color:#aaa;border:none;cursor:pointer;font-family:system-ui';
  idClose.addEventListener('mouseenter', () => { idClose.style.color = '#fff'; });
  idClose.addEventListener('mouseleave', () => { idClose.style.color = '#aaa'; });
  /**
   * Lets users dismiss identify results without triggering map interaction underneath the floating panel.
   */
  idClose.addEventListener('click', (e) => {
    e.stopPropagation();
    idPanel.style.display = 'none';
    if (_idHideTimer) { clearTimeout(_idHideTimer); _idHideTimer = null; }
  });
  idPanel.appendChild(idClose);
  
  const idContent = document.createElement('div');
  idPanel.appendChild(idContent);
  
  let _idHideTimer = null;
  /**
   * Displays geology identify results next to the pointer and owns the panel's auto-hide lifecycle. It hides immediately when no raster layer reports data so stale identify content is never shown.
   */
  function showIdPanel(x, y, info) {
    if (!info.bedrock && !info.quat) { idPanel.style.display = 'none'; return; }
    /**
     * Produces inline colour chips that match geology palette entries in the identify panel.
     */
    const swatch = (hex) => `<span style="display:inline-block;width:10px;height:10px;background:${hex};border:1px solid #888;margin-right:4px;vertical-align:middle"></span>`;
    let html = '';
    if (info.bedrock) html += `<div>${swatch(info.bedrock.color)}<b>Bedrock:</b> ${info.bedrock.name} <span style="opacity:0.6">(${info.bedrock.scale})</span></div>`;
    if (info.quat)    html += `<div>${swatch(info.quat.color)}<b>Quaternary:</b> ${info.quat.name} <span style="opacity:0.6">(${info.quat.scale})</span></div>`;
    idContent.innerHTML = html;
    idPanel.style.left = `${x + 12}px`;
    idPanel.style.top  = `${y + 12}px`;
    idPanel.style.display = 'block';
    if (_idHideTimer) clearTimeout(_idHideTimer);
    _idHideTimer = setTimeout(() => { idPanel.style.display = 'none'; }, 8000);
  }
  
  attachIdentifyHandlers({
    canvas: renderer.domElement,
    camera,
    scene,
    geologySystem,
    showPanel: showIdPanel,
  });
  // ---------------- end click-to-identify -----------------
  
  const culler = createFrustumCuller(THREE);
  const terrainLod = createTerrainLodRenderer({
    THREE, meta, centerX: CENTER_X, centerY: CENTER_Y, camera, renderer,
    frustum: culler.frustum,
    getTile: tileCache.getTile,
    meshPool: terrainMeshPool,
    /**
     * Supplies the current height exaggeration during tile evaluation instead of capturing the startup value.
     */
    getExag: () => EXAG,
    /**
     * Supplies the current screen-space-error threshold so LOD decisions reflect the latest UI setting.
     */
    getSsePx: () => SSE_PX,
    initialSeg: SEG,
    initialPlane,
    ELEV_MAX, SUN, FOG_NEAR, FOG_FAR, FOG_COLOR,
  });
  
  const compass = createCompass({ THREE, renderer, camera });

  // Named-feature labels (towns / peaks / hills / lakes). Loads features.json and creates
  // sprites lazily as the camera approaches each feature; toggle wired through controls.js.
  const labelsSystem = createLabelSystem({
    THREE,
    scene,
    getExag: () => EXAG,
  });
  labelsSystem.load();

  const appState = createAppState({
    exag: EXAG,
    ssePx: SSE_PX,
    seg: SEG,
    buildingRange: BLD_RANGE,
    canopyRange: CANOPY_RANGE,
    canopyLodLo: CANOPY_LOD_LO,
    canopyLodHi: CANOPY_LOD_HI,
  });
  
  attachControls({
    appState,
    systems: {
      roads: roadSystem,
      buildings: buildingSystem,
      amenities: amenitiesSystem,
      forest: forestSystem,
      water: waterSystem,
      geology: geologySystem,
      faults: faultSystem,
      labels: labelsSystem,
    },
    uniforms: {
      overlayUniforms,
      buildingUniforms,
      treeUniforms,
      canopyUniforms,
      waterUniforms,
      amenityAreaUniforms,
      amenityPropUniforms,
      geoUniforms,
      contourUniforms,
    },
    rebuildPlane: terrainLod.rebuildPlane,
    stateAccessors: {
      /**
       * Mirrors UI exaggeration into the render-loop closure so tile evaluation and overlays stay in sync.
       */
      setExag(value) { EXAG = value; },
      /**
       * Mirrors the terrain LOD screen-space-error threshold into the render-loop closure.
       */
      setSsePx(value) { SSE_PX = value; },
      /**
       * Mirrors the building visibility range used by the per-frame building updater.
       */
      setBuildingRange(value) { BLD_RANGE = value; },
      /**
       * Mirrors the canopy far range used by forest culling and fade uniforms.
       */
      setCanopyRange(value) { CANOPY_RANGE = value; },
      /**
       * Mirrors the lower and upper canopy LOD transition bounds as a pair to preserve the fade band invariant.
       */
      setCanopyLod(lo, hi) { CANOPY_LOD_LO = lo; CANOPY_LOD_HI = hi; },
      /**
       * Reports the terrain renderer's current segment count after any geometry rebuild.
       */
      getSegments() { return terrainLod.getSegments(); },
      /**
       * Toggles the per-tile outline overlay on every pooled terrain mesh.
       */
      setTileEdgesVisible(value) { terrainMeshPool.setEdgesVisible(value); },
    },
  });
  
  addEventListener('resize', viewerScene.resize);

  // Road-trip mode (E39 rail-guided camera). Constructed late so it can capture the latest
  // controls reference and the live EXAG getter; load() is fire-and-forget like other systems.
  const roadTripSystem = createRoadTripSystem({
    THREE,
    camera,
    controls,
    canvas: document.querySelector('canvas'),
    getExag: () => EXAG,
  });
  roadTripSystem.attachInput();
  roadTripSystem.load();
  attachRoadTripPanel({ roadTripSystem });

  startRenderLoop({
    controls, camera, culler, terrain: terrainLod,
    systems: { buildings: buildingSystem, forest: forestSystem, roadtrip: roadTripSystem, labels: labelsSystem },
    /**
     * Supplies the live building range to the render loop so per-frame culling honours UI changes.
     */
    getBldRange: () => BLD_RANGE,
    tileCache, renderer, scene, compass,
  });
}
