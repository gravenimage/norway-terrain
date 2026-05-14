import { assertMagic, concatFloat32 } from '../core/binary.js';

const TOWN_COLOR = '#7be0c8';
const ROAD_HALF_W = [6.5, 5.0, 4.0, 3.25, 2.75];

const overlayVert = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uExag;
uniform float uOffset;
void main(){
  vec3 p = position;
  p.z = max(p.z, 0.0) * uExag + uOffset;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;
const overlayFrag = /* glsl */`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
void main(){
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, 1.0);
}
`;

export const ROAD_CONTRACT = Object.freeze({
  magic: 'OSM2',
  units: 'metres',
  classes: '0..4 roads, 5 kommune boundaries',
});

function boundsFromSegments(segsByClass) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const segs of segsByClass) {
    for (let i = 0; i < segs.length; i += 2) {
      const x = segs[i];
      const y = segs[i + 1];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(xMin)) return { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  return { xMin, yMin, xMax, yMax };
}

export function parseRoadsBuffer(buffer) {
  const view = new DataView(buffer);
  assertMagic(view, ROAD_CONTRACT.magic);
  let off = 4;
  const nGroups = view.getUint32(off, true); off += 4;
  const centerX = view.getFloat64(off, true); off += 8;
  const centerY = view.getFloat64(off, true); off += 8;
  let totalSegs = 0;
  let townSegs = 0;
  const segsByClass = [[], [], [], [], []];
  const townGroups = [];

  for (let g = 0; g < nGroups; g += 1) {
    const cls = view.getUint8(off); off += 4;
    const n = view.getUint32(off, true); off += 4;
    const verts = new Float32Array(buffer, off, n * 3);
    off += n * 3 * 4;
    if (cls === 5) {
      townGroups.push({ cls, n, verts });
      townSegs += n / 2;
    } else if (cls >= 0 && cls <= 4) {
      const m = (n / 2) | 0;
      const out = new Float32Array(m * 4);
      for (let k = 0; k < m; k += 1) {
        out[k * 4 + 0] = verts[k * 6 + 0];
        out[k * 4 + 1] = verts[k * 6 + 1];
        out[k * 4 + 2] = verts[k * 6 + 3];
        out[k * 4 + 3] = verts[k * 6 + 4];
      }
      segsByClass[cls] = segsByClass[cls].length
        ? concatFloat32([segsByClass[cls], out])
        : out;
      totalSegs += m;
    }
  }

  return { nGroups, centerX, centerY, segsByClass, townGroups, totalSegs, townSegs };
}

export function createRoadSystem({
  THREE,
  scene,
  roadUniforms,
  overlayUniforms,
  roadsGroup,
  townsGroup,
  src = null,
  centerX = 0,
  centerY = 0,
}) {
  void scene;

  function makeLineMaterial(color) {
    return new THREE.ShaderMaterial({
      uniforms: { ...overlayUniforms, uColor: { value: new THREE.Color(color) } },
      vertexShader: overlayVert,
      fragmentShader: overlayFrag,
      transparent: false,
      depthTest: true,
      depthWrite: false,
    });
  }

  function buildRoadOverlay(segsByClass) {
    const fallbackBounds = boundsFromSegments(segsByClass);
    const xMinC = src ? src.xMin - centerX : fallbackBounds.xMin;
    const yMinC = src ? src.yMin - centerY : fallbackBounds.yMin;
    const W = src ? src.xMax - src.xMin : Math.max(1, fallbackBounds.xMax - fallbackBounds.xMin);
    const H = src ? src.yMax - src.yMin : Math.max(1, fallbackBounds.yMax - fallbackBounds.yMin);
    const cell = 100.0;
    const gridW = Math.ceil(W / cell);
    const gridH = Math.ceil(H / cell);

    let N = 0;
    for (let cls = 0; cls < 5; cls += 1) N += (segsByClass[cls].length / 4) | 0;

    const segAx = new Float32Array(N);
    const segAy = new Float32Array(N);
    const segBx = new Float32Array(N);
    const segBy = new Float32Array(N);
    const segCls = new Uint8Array(N);
    {
      let i = 0;
      for (let cls = 0; cls < 5; cls += 1) {
        const arr = segsByClass[cls];
        const m = (arr.length / 4) | 0;
        for (let k = 0; k < m; k += 1) {
          segAx[i] = arr[k * 4 + 0];
          segAy[i] = arr[k * 4 + 1];
          segBx[i] = arr[k * 4 + 2];
          segBy[i] = arr[k * 4 + 3];
          segCls[i] = cls;
          i += 1;
        }
      }
    }

    const cellCount = gridW * gridH;
    const cells = new Array(cellCount);
    for (let i = 0; i < cellCount; i += 1) cells[i] = [];
    let maxCellCount = 0;
    for (let i = 0; i < N; i += 1) {
      const cls = segCls[i];
      const hw = ROAD_HALF_W[cls];
      const minX = Math.min(segAx[i], segBx[i]) - hw;
      const maxX = Math.max(segAx[i], segBx[i]) + hw;
      const minY = Math.min(segAy[i], segBy[i]) - hw;
      const maxY = Math.max(segAy[i], segBy[i]) + hw;
      let cx0 = Math.floor((minX - xMinC) / cell);
      let cx1 = Math.floor((maxX - xMinC) / cell);
      let cy0 = Math.floor((minY - yMinC) / cell);
      let cy1 = Math.floor((maxY - yMinC) / cell);
      if (cx1 < 0 || cy1 < 0 || cx0 >= gridW || cy0 >= gridH) continue;
      if (cx0 < 0) cx0 = 0;
      if (cx1 >= gridW) cx1 = gridW - 1;
      if (cy0 < 0) cy0 = 0;
      if (cy1 >= gridH) cy1 = gridH - 1;
      for (let cy = cy0; cy <= cy1; cy += 1) {
        for (let cx = cx0; cx <= cx1; cx += 1) {
          cells[cy * gridW + cx].push(i);
        }
      }
    }

    let totalRefs = 0;
    for (let c = 0; c < cellCount; c += 1) {
      const n = cells[c].length;
      if (n > maxCellCount) maxCellCount = n;
      totalRefs += n;
    }

    const refsTexW = 2048;
    const refsTexH = Math.max(1, Math.ceil(totalRefs / refsTexW));
    const refsData = new Float32Array(refsTexW * refsTexH * 4);
    const clsData = new Uint8Array(refsTexW * refsTexH);
    const gridData = new Float32Array(gridW * gridH * 2);

    let p = 0;
    for (let c = 0; c < cellCount; c += 1) {
      const list = cells[c];
      gridData[c * 2 + 0] = p;
      gridData[c * 2 + 1] = list.length;
      let lim = list.length;
      if (lim > 128) {
        list.sort((a, b) => segCls[a] - segCls[b]);
        lim = 128;
        gridData[c * 2 + 1] = 128;
      }
      for (let kk = 0; kk < lim; kk += 1) {
        const idx = list[kk];
        refsData[p * 4 + 0] = segAx[idx];
        refsData[p * 4 + 1] = segAy[idx];
        refsData[p * 4 + 2] = segBx[idx];
        refsData[p * 4 + 3] = segBy[idx];
        clsData[p] = segCls[idx];
        p += 1;
      }
    }

    const gridTex = new THREE.DataTexture(gridData, gridW, gridH, THREE.RGFormat, THREE.FloatType);
    gridTex.minFilter = THREE.NearestFilter;
    gridTex.magFilter = THREE.NearestFilter;
    gridTex.wrapS = THREE.ClampToEdgeWrapping;
    gridTex.wrapT = THREE.ClampToEdgeWrapping;
    gridTex.needsUpdate = true;

    const refsTex = new THREE.DataTexture(refsData, refsTexW, refsTexH, THREE.RGBAFormat, THREE.FloatType);
    refsTex.minFilter = THREE.NearestFilter;
    refsTex.magFilter = THREE.NearestFilter;
    refsTex.wrapS = THREE.ClampToEdgeWrapping;
    refsTex.wrapT = THREE.ClampToEdgeWrapping;
    refsTex.needsUpdate = true;

    const clsTex = new THREE.DataTexture(clsData, refsTexW, refsTexH, THREE.RedFormat, THREE.UnsignedByteType);
    clsTex.minFilter = THREE.NearestFilter;
    clsTex.magFilter = THREE.NearestFilter;
    clsTex.wrapS = THREE.ClampToEdgeWrapping;
    clsTex.wrapT = THREE.ClampToEdgeWrapping;
    clsTex.needsUpdate = true;

    roadUniforms.uRoadGrid.value = gridTex;
    roadUniforms.uRoadRefs.value = refsTex;
    roadUniforms.uRoadCls.value = clsTex;
    roadUniforms.uRoadOrigin.value.set(xMinC, yMinC);
    roadUniforms.uRoadCell.value = cell;
    roadUniforms.uRoadGridDims.value.set(gridW, gridH);
    roadUniforms.uRoadRefsDims.value.set(refsTexW, refsTexH);
    roadUniforms.uRoadReady.value = 1.0;

    window.__roadGrid = { gridW, gridH, gridData, maxCellCount, totalRefs, N, cell, xMinC, yMinC };

    console.log(`roads: ${N.toLocaleString()} segs · grid ${gridW}×${gridH} @ ${cell}m · ${totalRefs.toLocaleString()} refs · max ${maxCellCount} segs/cell · refs tex ${refsTexW}×${refsTexH}`);
    if (maxCellCount > 128) console.warn(`road grid: ${maxCellCount} > 128 segs in some cell — overflow truncated`);
  }

  return {
    async load() {
      try {
        const ab = await (await fetch('osm.bin')).arrayBuffer();
        const parsed = parseRoadsBuffer(ab);
        for (const { verts } of parsed.townGroups) {
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
          const mat = makeLineMaterial(TOWN_COLOR);
          const ls = new THREE.LineSegments(geom, mat);
          ls.frustumCulled = false;
          ls.renderOrder = 11;
          townsGroup.add(ls);
        }
        buildRoadOverlay(parsed.segsByClass);
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>roads: ${parsed.totalSegs.toLocaleString()} segs · kommune: ${parsed.townSegs.toLocaleString()} segs`);
      } catch (e) {
        console.warn('osm.bin not loaded:', e);
      }
    },
    setRoadsVisible(visible) {
      roadUniforms.uRoadShow.value = visible ? 1.0 : 0.0;
      if (roadsGroup) roadsGroup.visible = visible;
    },
    setTownsVisible(visible) {
      townsGroup.visible = visible;
    },
    setExaggeration(value) {
      overlayUniforms.uExag.value = value;
    },
    setDrapeOffset(value) {
      overlayUniforms.uOffset.value = value;
    },
  };
}
