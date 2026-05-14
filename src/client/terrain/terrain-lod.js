import { tileBounds } from './tile-pyramid.js';

export function createTerrainLodRenderer({
  THREE,
  meta,
  centerX,
  centerY,
  camera,
  renderer,
  frustum,
  getTile,
  meshPool,
  getExag,
  getSsePx,
  initialSeg,
  initialPlane,
  ELEV_MAX,
  SUN,
  FOG_NEAR,
  FOG_FAR,
  FOG_COLOR,
}) {
  const MAX_Z = meta.maxZ;
  const SRC = meta.src;

  let SEG = initialSeg;
  let plane = initialPlane;
  let drawn = 0;

  // Per-frame mutable copies, refreshed once at visitRoot to avoid repeated getter calls
  let EXAG = getExag();
  let SSE_PX = getSsePx();

  const _v = new THREE.Vector3();
  const _box = new THREE.Box3();
  const _bmin = new THREE.Vector3();
  const _bmax = new THREE.Vector3();

  function tileBoundsWorld(z, x, y) {
    const b = tileBounds(meta, z, x, y);
    return { xmin: b.x0 - centerX, ymin: b.y0 - centerY, xmax: b.x1 - centerX, ymax: b.y1 - centerY, size: b.size };
  }

  function tileIntersectsSrc(z, x, y) {
    const b = tileBounds(meta, z, x, y);
    return !(b.x1 <= SRC.xMin || b.x0 >= SRC.xMax || b.y1 <= SRC.yMin || b.y0 >= SRC.yMax);
  }

  function projectedSizePx(b) {
    const cx = (b.xmin + b.xmax) / 2;
    const cy = (b.ymin + b.ymax) / 2;
    _v.set(cx, cy, 0);
    const dist = Math.max(camera.position.distanceTo(_v), 1);
    const halfH = Math.tan(camera.fov * Math.PI / 360) * dist;
    return (b.size / (2 * halfH)) * renderer.domElement.height;
  }

  function inFrustum(b) {
    _bmin.set(b.xmin, b.ymin, 0);
    _bmax.set(b.xmax, b.ymax, ELEV_MAX * EXAG + 50);
    _box.set(_bmin, _bmax);
    return frustum.intersectsBox(_box);
  }

  function visit(z, x, y) {
    if (!tileIntersectsSrc(z, x, y)) return;
    const b = tileBoundsWorld(z, x, y);
    if (!inFrustum(b)) return;
    const screenPx = projectedSizePx(b);
    const sse = screenPx / SEG;
    if (z < MAX_Z && sse > SSE_PX) {
      visit(z+1, x*2,   y*2);
      visit(z+1, x*2+1, y*2);
      visit(z+1, x*2,   y*2+1);
      visit(z+1, x*2+1, y*2+1);
      return;
    }
    let tz = z, tx = x, ty = y;
    let t = getTile(tz, tx, ty);
    while ((!t.tex || t.missing) && tz > 0) {
      tz--; tx >>= 1; ty >>= 1;
      t = getTile(tz, tx, ty);
    }
    if (!t.tex) return;
    drawTile(z, x, y, b, tz, tx, ty, t.tex);
  }

  function drawTile(z, x, y, b, tz, tx, ty, tex) {
    const m = meshPool.acquire();
    m.position.set((b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, 0);
    m.scale.set(b.size, b.size, 1);
    const u = m.material.uniforms;
    u.uHeight.value = tex;
    u.uOriginXY.value.set(b.xmin, b.ymin);
    u.uTileSize.value = b.size;
    u.uExag.value = EXAG;
    u.uElevMax.value = ELEV_MAX;
    u.uSun.value.copy(SUN);
    u.uSeg.value = SEG;
    u.uFogNear.value = FOG_NEAR;
    u.uFogFar.value = FOG_FAR;
    u.uFogColor.value = FOG_COLOR;
    if (tz === z) {
      u.uUVScale.value.set(1, 1);
      u.uUVOffset.value.set(0, 0);
    } else {
      const dz = z - tz;
      const span = 1.0 / (1 << dz);
      const ax = x - (tx << dz);
      const ay = y - (ty << dz);
      u.uUVScale.value.set(span, span);
      u.uUVOffset.value.set(ax * span, ay * span);
    }
    drawn++;
  }

  function visitRoot() {
    EXAG = getExag();
    SSE_PX = getSsePx();
    drawn = 0;
    visit(0, 0, 0);
  }

  function rebuildPlane(seg) {
    const old = plane;
    SEG = seg;
    plane = new THREE.PlaneGeometry(1, 1, SEG, SEG);
    old.dispose();
    meshPool.setGeometry(plane);
  }

  function getDrawnCount() {
    return drawn;
  }

  function getSegments() {
    return SEG;
  }

  return { visitRoot, rebuildPlane, getDrawnCount, getSegments, recycleAll: () => meshPool.recycleAll() };
}
