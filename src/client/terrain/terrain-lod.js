/**
 * @file Traverses the terrain tile pyramid and draws the visible LOD set for each frame.
 */

import { tileBounds } from './tile-pyramid.js';
import { makeTileEdgeGeometry } from './tile-edge-geometry.js';

/**
 * Builds the LOD renderer that chooses tiles by projected screen size and submits them through the mesh pool.
 * It keeps shared uniforms mutable and updates their values in place so pooled materials remain reusable.
 */
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

  /**
   * Converts source tile bounds into the centered world coordinates used by meshes and frustum tests.
   * Keeping this translation local prevents LOD math from depending on scene origin placement.
   */
  function tileBoundsWorld(z, x, y) {
    const b = tileBounds(meta, z, x, y);
    return { xmin: b.x0 - centerX, ymin: b.y0 - centerY, xmax: b.x1 - centerX, ymax: b.y1 - centerY, size: b.size };
  }

  /**
   * Rejects pyramid nodes that cannot overlap the source raster before any world-space work is done.
   * This keeps recursion bounded to real terrain coverage even when the root tile is larger than the source.
   */
  function tileIntersectsSrc(z, x, y) {
    const b = tileBounds(meta, z, x, y);
    return !(b.x1 <= SRC.xMin || b.x0 >= SRC.xMax || b.y1 <= SRC.yMin || b.y0 >= SRC.yMax);
  }

  /**
   * Estimates how many screen pixels a tile spans to drive screen-space error refinement.
   * The formula projects tile size against camera frustum height: size / (2 * tan(fov/2) * distance) * viewportHeight.
   */
  function projectedSizePx(b) {
    const cx = (b.xmin + b.xmax) / 2;
    const cy = (b.ymin + b.ymax) / 2;
    _v.set(cx, cy, 0);
    const dist = Math.max(camera.position.distanceTo(_v), 1);
    const halfH = Math.tan(camera.fov * Math.PI / 360) * dist;
    return (b.size / (2 * halfH)) * renderer.domElement.height;
  }

  /**
   * Tests a conservative terrain volume against the current camera frustum before tile loading or drawing.
   * The elevation bound includes exaggeration so tall terrain is not culled when height scale changes.
   */
  function inFrustum(b) {
    _bmin.set(b.xmin, b.ymin, 0);
    _bmax.set(b.xmax, b.ymax, ELEV_MAX * EXAG + 50);
    _box.set(_bmin, _bmax);
    return frustum.intersectsBox(_box);
  }

  /**
   * Recursively selects the visible tile set in deterministic row-major child order before drawing leaves.
   * A node refines when projectedSizePx(bounds) / SEG exceeds the SSE threshold, otherwise it draws or falls back to an ancestor texture.
   */
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

  /**
   * Binds one selected tile to a pooled mesh and mutates its shared uniforms in place for this draw.
   * Ancestor texture fallback adjusts UV scale and offset so missing child tiles still sample the correct subregion.
   */
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

  /**
   * Starts a frame's LOD traversal from the root after refreshing mutable render settings once.
   * The returned method intentionally resets draw accounting before visit performs recursive selection.
   */
  function visitRoot() {
    EXAG = getExag();
    SSE_PX = getSsePx();
    drawn = 0;
    visit(0, 0, 0);
  }

  /**
   * Replaces the shared plane geometry when terrain tessellation changes without rebuilding the renderer.
   * The mesh pool is pointed at the new geometry so future reacquisitions bind the updated segment count.
   */
  function rebuildPlane(seg) {
    const old = plane;
    SEG = seg;
    plane = new THREE.PlaneGeometry(1, 1, SEG, SEG);
    old.dispose();
    const edgeGeom = makeTileEdgeGeometry(THREE, SEG);
    meshPool.setGeometry(plane, edgeGeom);
  }

  /**
   * Returns the number of tile meshes drawn by the most recent visitRoot call for diagnostics and tests.
   */
  function getDrawnCount() {
    return drawn;
  }

  /**
   * Exposes the current terrain segment density so callers can verify geometry and LOD state stay aligned.
   */
  function getSegments() {
    return SEG;
  }

  return {
    visitRoot,
    rebuildPlane,
    getDrawnCount,
    getSegments,
    /**
     * Returns all terrain meshes to the pool after a frame so the next visitRoot can reacquire visible tiles.
     */
    recycleAll: () => meshPool.recycleAll(),
  };
}
