/**
 * @file Place-name labels: floating sprites above named OSM features (towns, peaks, hills,
 * lakes) within a culling radius of the camera. Loads `features.json` produced by
 * `extract_named_features.py`; each entry stores raw DEM elevation, which is multiplied by the
 * live exaggeration so labels track the visible terrain surface.
 *
 * Rendering notes:
 *   - Each label is a `THREE.Sprite` with a per-label CanvasTexture rendered at low pixel size
 *     and sampled with NearestFilter for an 8-bit / chunky look.
 *   - Sprites are created lazily the first time a feature enters range so a dataset of ~12k
 *     features doesn't allocate ~12k textures up front.
 *   - The label group lives directly under the scene root; the system never transforms it, only
 *     individual sprite positions / visibility.
 */

const LABEL_HEIGHT_M = 75;       // metres above the terrain surface
const CULL_RADIUS_M = 2000;      // 2 km from camera
const CULL_RADIUS_SQ = CULL_RADIUS_M * CULL_RADIUS_M;
const LABEL_WORLD_HEIGHT = 30;   // world-space sprite height in metres; width scales by aspect
// Render last + skip depth-test so labels are never occluded by trees, water, buildings, or
// each other. Terrain occlusion is lost as a side-effect, which is the desired UX for map-style
// "name tags": you can read the label of any nearby feature even if it's behind a hill.
const LABEL_RENDER_ORDER = 999;

/**
 * Parse a `features.json` payload into a stable array of plain feature records. Throws on bad
 * shape so callers don't silently fall back to empty.
 */
export function parseFeaturesJson(json) {
  if (!json || !Array.isArray(json.features)) {
    throw new Error('features.json: expected { features: [...] }');
  }
  const out = new Array(json.features.length);
  for (let i = 0; i < json.features.length; i++) {
    const f = json.features[i];
    out[i] = {
      name: String(f.name ?? ''),
      kind: String(f.kind ?? ''),
      rank: Number.isFinite(f.rank) ? f.rank : 99,
      x: +f.x,
      y: +f.y,
      z: +f.z,
    };
  }
  return out;
}

/**
 * Decide which features within `cullRadiusSq` are currently visible. Returns an array of
 * indices into `features`. Pure function; tests use it without any Three.js dependency.
 */
export function pickVisibleIndices(features, cameraX, cameraY, cullRadiusSq) {
  const visible = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const dx = cameraX - f.x;
    const dy = cameraY - f.y;
    if (dx * dx + dy * dy <= cullRadiusSq) visible.push(i);
  }
  return visible;
}

/**
 * Render a label string into a small canvas for the 8-bit look. Returns the canvas plus the
 * texture-pixel dimensions so callers can size their sprite to preserve aspect ratio.
 *
 * The canvas is intentionally rendered at a small pixel size and then sampled with NearestFilter
 * on the GPU; that's where the chunky look comes from.
 */
function renderLabelCanvas(text, kind) {
  const fontPx = 10;
  const padX = 4;
  const padY = 3;
  const cvs = document.createElement('canvas');
  let ctx = cvs.getContext('2d');
  ctx.font = `${fontPx}px monospace`;
  const w = Math.max(1, Math.ceil(ctx.measureText(text).width));
  cvs.width = w + padX * 2;
  cvs.height = fontPx + padY * 2;
  ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.font = `${fontPx}px monospace`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, cvs.width, cvs.height);
  // Per-kind text colour: warm for settlements, cool for water, light for terrain peaks.
  const colour = kind === 'lake'
    ? '#9fd4ff'
    : (kind === 'peak' || kind === 'hill')
      ? '#ffe7a8'
      : '#ffffff';
  ctx.fillStyle = colour;
  ctx.fillText(text, padX, padY);
  return cvs;
}

/**
 * Construct the labels system. Owns one THREE.Group of sprites; load() fetches features.json,
 * update(camera) re-evaluates visibility, setExag re-derives sprite Z to track the terrain.
 */
export function createLabelSystem({
  THREE,
  scene,
  src = 'features.json',
  getExag = () => 1.0,
} = {}) {
  if (!THREE) throw new Error('createLabelSystem: THREE is required');
  if (!scene) throw new Error('createLabelSystem: scene is required');

  const group = new THREE.Group();
  group.name = 'labels';
  group.frustumCulled = false;
  scene.add(group);

  let features = [];
  let sprites = [];       // sprite[i] or null until materialised
  let visible = true;
  let lastCamX = NaN;
  let lastCamY = NaN;
  let lastExag = NaN;
  const REEVAL_DIST_SQ = 25 * 25; // re-cull only after the camera moves >25m horizontally

  /**
   * Lazily create the THREE.Sprite for feature `i` and add it to the scene group. Skips work
   * if the sprite already exists. Returns the sprite for chaining.
   */
  function materialiseSprite(i) {
    if (sprites[i]) return sprites[i];
    const f = features[i];
    const cvs = renderLabelCanvas(f.name, f.kind);
    const tex = new THREE.CanvasTexture(cvs);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = LABEL_RENDER_ORDER;
    const aspect = cvs.width / cvs.height;
    sprite.scale.set(LABEL_WORLD_HEIGHT * aspect, LABEL_WORLD_HEIGHT, 1);
    sprite.position.set(f.x, f.y, f.z * getExag() + LABEL_HEIGHT_M);
    sprite.visible = false; // update() will flip on visible ones this frame
    group.add(sprite);
    sprites[i] = sprite;
    return sprite;
  }

  async function load() {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`labels: fetch ${src} failed: ${res.status}`);
    const json = await res.json();
    features = parseFeaturesJson(json);
    sprites = new Array(features.length).fill(null);
    // Force a cull pass on next update.
    lastCamX = NaN;
    lastCamY = NaN;
  }

  /**
   * Per-frame culling. Only re-evaluates when the camera moves far enough horizontally or when
   * exaggeration changes (re-derives every materialised sprite's Z). Sprites for features that
   * have ever come within range are kept around — disposal would just churn allocations.
   */
  function update(camera) {
    if (!visible || features.length === 0) return;
    const camX = camera.position.x;
    const camY = camera.position.y;
    const exag = getExag();
    const exagChanged = exag !== lastExag;
    if (exagChanged) {
      // Update the Z of every already-materialised sprite to track the visible terrain surface.
      for (let i = 0; i < sprites.length; i++) {
        const s = sprites[i];
        if (s) s.position.z = features[i].z * exag + LABEL_HEIGHT_M;
      }
      lastExag = exag;
    }
    const dx = camX - lastCamX;
    const dy = camY - lastCamY;
    const moved = !(dx * dx + dy * dy < REEVAL_DIST_SQ);
    if (!moved) return;
    lastCamX = camX;
    lastCamY = camY;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const ddx = camX - f.x;
      const ddy = camY - f.y;
      const inRange = ddx * ddx + ddy * ddy <= CULL_RADIUS_SQ;
      if (inRange) {
        const sprite = sprites[i] || materialiseSprite(i);
        sprite.visible = true;
      } else if (sprites[i]) {
        sprites[i].visible = false;
      }
    }
  }

  function setVisible(v) {
    visible = !!v;
    group.visible = visible;
  }

  /**
   * Notify the system that exaggeration changed (mirrors the road-trip system's contract). The
   * actual Z update happens lazily inside update(), so this just nudges the system to re-eval.
   */
  function setExag(_value) {
    lastCamX = NaN; // force the next update() to also re-cull
  }

  return {
    load,
    update,
    setVisible,
    setExag,
    _internal: { group, getFeatures: () => features, getSprites: () => sprites },
  };
}
