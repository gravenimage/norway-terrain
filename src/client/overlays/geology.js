/** @file Loads BRR1/QRR1 geology rasters, palettes them, and samples map clicks. */
import { readMagic } from '../core/binary.js';

export const GEOLOGY_RASTER_CONTRACT = Object.freeze({
  bedrockMagic: 'BRR1',
  quaternaryMagic: 'QRR1',
  units: 'metres',
  headerBytes: 32,
  idType: 'uint16',
});

/**
 * Parse a geology raster binary with magic `BRR1` (bedrock) or `QRR1` (quaternary).
 * This pure parser has no THREE dependency and returns `{ magic, version, w, h, ids,
 * rgBytes, bbox }`, where `ids` is a Uint16Array of class IDs and `rgBytes` is a
 * Uint8Array view of the same raster bytes for RG texture upload.
 */
export function parseGeologyRasterBuffer(buffer, expectedMagic) {
  const view = new DataView(buffer);
  const magic = readMagic(view, 0, 4);
  if (magic !== expectedMagic) {
    throw new Error(`bad magic ${magic}, expected ${expectedMagic}`);
  }
  const version = view.getUint32(4, true);
  const w = view.getUint32(8, true);
  const h = view.getUint32(12, true);
  const xMin = view.getFloat32(16, true);
  const yMin = view.getFloat32(20, true);
  const xMax = view.getFloat32(24, true);
  const yMax = view.getFloat32(28, true);
  const ids = new Uint16Array(buffer, GEOLOGY_RASTER_CONTRACT.headerBytes, w * h);
  const rgBytes = new Uint8Array(buffer, GEOLOGY_RASTER_CONTRACT.headerBytes, w * h * 2);
  return { magic, version, w, h, ids, rgBytes, bbox: { xMin, yMin, xMax, yMax } };
}

/** Convert palette `#rrggbb` strings into RGB bytes for palette textures. */
function hexToRgbBytes(hex) {
  if (!hex || hex.length !== 7) return [180, 180, 180];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Sample a parsed geology raster in world metres and return its class ID.
 * Raster rows are addressed directly from `yMin` upward with NO Y-flip, unlike the
 * height texture path.
 */
function sampleRaster(raster, wx, wy) {
  if (!raster) return 0;
  const { bbox, w, h, ids } = raster;
  const u = (wx - bbox.xMin) / (bbox.xMax - bbox.xMin);
  const v = (wy - bbox.yMin) / (bbox.yMax - bbox.yMin);
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  let col = Math.floor(u * w);
  let row = Math.floor(v * h);
  if (col >= w) col = w - 1;
  if (row >= h) row = h - 1;
  return ids[row * w + col];
}

/**
 * Create the stateful geology raster overlay system.
 * `THREE` is a shared renderer dependency, `geoUniforms` are shared shader uniforms
 * mutated by this system, and `faultsGroup` is accepted for overlay factory parity
 * but not owned or modified here.
 */
export function createGeologySystem({ THREE, geoUniforms, faultsGroup }) {
  void faultsGroup;
  let bedrockLookup = {};
  let quaternaryLookup = {};
  let bedrockRaster = null;
  let quatRaster = null;

  /** Build a 1D RGBA DataTexture mapping numeric geology IDs to palette colors. */
  function buildPaletteTex(lookupObj) {
    let maxId = 0;
    for (const k of Object.keys(lookupObj)) {
      const n = parseInt(k, 10);
      if (n > maxId) maxId = n;
    }
    const N = maxId + 1;
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      const entry = lookupObj[String(i)];
      if (entry && entry.color) {
        const [r, g, b] = hexToRgbBytes(entry.color);
        data[i * 4 + 0] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
      } else {
        data[i * 4 + 3] = 0;
      }
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return { tex, N };
  }

  /**
   * Fetch one BRR1/QRR1 raster plus its JSON palette and convert both to THREE
   * textures. The data texture keeps `flipY = false` so sampling and shader lookup
   * use the same no-Y-flip raster orientation.
   */
  async function loadGeologyRaster(binUrl, paletteUrl, magic) {
    let buf;
    let lookupObj = {};
    try {
      const r = await fetch(binUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = await r.arrayBuffer();
    } catch (e) {
      console.warn(`${binUrl} not loaded:`, e.message);
      return null;
    }
    try {
      const jr = await fetch(paletteUrl);
      if (jr.ok) lookupObj = await jr.json();
    } catch {}

    let parsed;
    try {
      parsed = parseGeologyRasterBuffer(buf, magic);
    } catch (e) {
      console.warn(`${binUrl}: ${e.message}`);
      return null;
    }
    const { w, h, ids, rgBytes, bbox } = parsed;
    const tex = new THREE.DataTexture(rgBytes, w, h, THREE.RGFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    tex.needsUpdate = true;
    const palInfo = buildPaletteTex(lookupObj);
    console.log(`${binUrl}: ${w}x${h} raster, palette N=${palInfo.N}`);
    return {
      w, h, ids, bbox,
      tex, paletteTex: palInfo.tex, paletteN: palInfo.N,
      lookup: lookupObj,
    };
  }

  /** Copy a loaded raster bbox into the shared geology uniform as x/y/width/height. */
  function setGeoBBoxFrom(r) {
    geoUniforms.uGeoBBox.value.set(
      r.bbox.xMin,
      r.bbox.yMin,
      r.bbox.xMax - r.bbox.xMin,
      r.bbox.yMax - r.bbox.yMin,
    );
  }

  return {
    /** Load the BRR1 bedrock raster and assign its texture/palette uniforms. */
    async loadBedrock() {
      const r = await loadGeologyRaster('bedrock_raster.bin', 'bedrock_palette.json', GEOLOGY_RASTER_CONTRACT.bedrockMagic);
      if (!r) return;
      bedrockRaster = r;
      bedrockLookup = r.lookup;
      geoUniforms.uBedTex.value = r.tex;
      geoUniforms.uBedPalette.value = r.paletteTex;
      geoUniforms.uBedPalN.value = r.paletteN;
      setGeoBBoxFrom(r);
    },
    /** Load the QRR1 quaternary raster and assign its texture/palette uniforms. */
    async loadQuaternary() {
      const r = await loadGeologyRaster('quaternary_raster.bin', 'quaternary_palette.json', GEOLOGY_RASTER_CONTRACT.quaternaryMagic);
      if (!r) return;
      quatRaster = r;
      quaternaryLookup = r.lookup;
      geoUniforms.uQuatTex.value = r.tex;
      geoUniforms.uQuatPalette.value = r.paletteTex;
      geoUniforms.uQuatPalN.value = r.paletteN;
      setGeoBBoxFrom(r);
    },
    /** Toggle the shared bedrock visibility uniform without unloading raster data. */
    setBedrockVisible(visible) {
      geoUniforms.uBedShow.value = visible ? 1.0 : 0.0;
    },
    /** Toggle the shared quaternary visibility uniform without unloading raster data. */
    setQuaternaryVisible(visible) {
      geoUniforms.uQuatShow.value = visible ? 1.0 : 0.0;
    },
    /** Set the shared opacity uniform used by both geology raster overlays. */
    setOpacity(opacity) {
      geoUniforms.uGeoOpacity.value = opacity;
    },
    /**
     * Return lookup entries for visible geology rasters at world x/y metres.
     * Uses the same no-Y-flip raster addressing as the uploaded BRR1/QRR1 textures.
     */
    sampleAt(worldX, worldY) {
      if (geoUniforms.uBedShow.value < 0.5 && geoUniforms.uQuatShow.value < 0.5) return null;
      const out = {};
      const bid = sampleRaster(bedrockRaster, worldX, worldY);
      if (bid > 0 && bedrockLookup[String(bid)]) out.bedrock = bedrockLookup[String(bid)];
      const qid = sampleRaster(quatRaster, worldX, worldY);
      if (qid > 0 && quaternaryLookup[String(qid)]) out.quat = quaternaryLookup[String(qid)];
      return out;
    },
  };
}
