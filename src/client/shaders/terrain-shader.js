export const vertexShader = String.raw`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uHeight;
uniform vec2 uOriginXY;
uniform float uTileSize;
uniform float uExag;
uniform vec2 uUVScale;
uniform vec2 uUVOffset;
varying vec3 vWorld;
varying vec2 vUv;
varying float vH;
float decode(vec3 c){ return -10000.0 + (c.r*255.0*65536.0 + c.g*255.0*256.0 + c.b*255.0)*0.1; }
void main(){
  vUv = uv;
  vec2 sUv = uUVOffset + uv * uUVScale;
  vec2 tuv = vec2(sUv.x, 1.0 - sUv.y);
  float h = decode(texture2D(uHeight, tuv).rgb);
  h = max(h, 0.0) * uExag;
  vec2 wxy = uOriginXY + uv * uTileSize;
  vWorld = vec3(wxy, h);
  vH = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const fragmentShader = String.raw`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uHeight;
uniform float uTileSize;
uniform float uExag;
uniform float uElevMax;
uniform float uSeg;
uniform vec3 uSun;
uniform vec2 uUVScale;
uniform vec2 uUVOffset;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uFogColor;
// ----- geology overlay uniforms (shared across all terrain materials) -----
uniform sampler2D uBedTex;
uniform sampler2D uBedPalette;
uniform float uBedShow;       // 0 or 1
uniform float uBedPalN;       // number of palette entries (>= 1)
uniform sampler2D uQuatTex;
uniform sampler2D uQuatPalette;
uniform float uQuatShow;
uniform float uQuatPalN;
uniform vec4 uGeoBBox;        // xMin, yMin, xMax-xMin, yMax-yMin (centred world)
uniform float uGeoOpacity;
// ----- contour uniforms (shared across all terrain materials) -----
uniform float uContourShow;       // 0 or 1
uniform float uContourInterval;   // metres (real world)
uniform float uContourBoldEvery;  // e.g. 5 -> every 5th line is an index contour
uniform vec3  uContourColor;
uniform vec3  uContourBoldColor;
uniform float uContourOpacity;
// ----- road overlay uniforms (shared across all terrain materials) -----
uniform sampler2D uRoadGrid;      // RG float, per-cell (offset, count) into uRoadRefs
uniform sampler2D uRoadRefs;      // RGBA float, per ref (ax, ay, bx, by) centred world
uniform sampler2D uRoadCls;       // R8, per ref class (0..4) stored as cls/255
uniform vec2  uRoadOrigin;        // (xMinC, yMinC) — bottom-left of grid in centred coords
uniform float uRoadCell;          // metres per grid cell
uniform vec2  uRoadGridDims;      // (gridW, gridH)
uniform vec2  uRoadRefsDims;      // (refsTexW, refsTexH)
uniform float uRoadShow;          // 0 or 1
uniform float uRoadReady;         // 0 until osm.bin is parsed and textures uploaded
varying vec3 vWorld;
varying vec2 vUv;
varying float vH;
float decode(vec3 c){ return -10000.0 + (c.r*255.0*65536.0 + c.g*255.0*256.0 + c.b*255.0)*0.1; }
float sampleH(vec2 uv){
  vec2 sUv = uUVOffset + uv * uUVScale;
  vec2 tuv = vec2(sUv.x, 1.0 - sUv.y);
  return max(decode(texture2D(uHeight, tuv).rgb), 0.0) * uExag;
}
vec4 sampleGeo(sampler2D tex, sampler2D pal, float palN, vec2 wxy) {
  vec2 uv = vec2((wxy.x - uGeoBBox.x) / uGeoBBox.z, (wxy.y - uGeoBBox.y) / uGeoBBox.w);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  vec2 rg = texture2D(tex, uv).rg;
  float idF = floor(rg.r * 255.0 + 0.5) + floor(rg.g * 255.0 + 0.5) * 256.0;
  if (idF < 0.5 || palN < 1.0) return vec4(0.0);
  vec2 puv = vec2((idF - 0.5) / palN, 0.5);
  return vec4(texture2D(pal, puv).rgb, 1.0);
}
// Compute centre-of-texel UV for a 1-D ref index packed into the (refsTexW × refsTexH) texture.
vec2 _refUV(float i){
  float w = uRoadRefsDims.x;
  float h = uRoadRefsDims.y;
  float row = floor(i / w);
  float colF = i - row * w;
  return vec2((colF + 0.5) / w, (row + 0.5) / h);
}
float _distSeg(vec2 p, vec2 a, vec2 b){
  vec2 d = b - a;
  float L2 = max(dot(d, d), 1e-6);
  float t = clamp(dot(p - a, d) / L2, 0.0, 1.0);
  return length(p - (a + d * t));
}
vec3 ramp(float zReal){
  // Rogaland palette: emerald coastal forest → mossy heath → dark upland heath.
  // No tans/golds — Norwegian uplands are heather/crowberry/peat, not dry grass.
  vec3 c0 = vec3(0.07, 0.26, 0.10); //   0– 30 m  emerald coastal forest
  vec3 c1 = vec3(0.10, 0.28, 0.11); //  30–100 m  deep forest green
  vec3 c2 = vec3(0.16, 0.28, 0.13); // 100–200 m  mossy green, browner
  vec3 c3 = vec3(0.18, 0.24, 0.13); // 200–320 m  dark heath (olive-brown)
  vec3 c4 = vec3(0.20, 0.21, 0.15); // 320–400 m  peat/heath, hint of purple
  if (zReal <  30.0) return c0;
  if (zReal < 100.0) return c1;
  if (zReal < 200.0) return c2;
  if (zReal < 320.0) return c3;
  return c4;
}
void main(){
  #include <logdepthbuf_fragment>
  // identify the current quad cell of the geometry tessellation
  vec2 q  = floor(vUv * uSeg) / uSeg;
  float d = 1.0 / uSeg;
  // sample heights at the 4 corners of the quad
  float h00 = sampleH(q);
  float h10 = sampleH(q + vec2(d, 0.0));
  float h01 = sampleH(q + vec2(0.0, d));
  float h11 = sampleH(q + vec2(d, d));
  float havg = 0.25 * (h00 + h10 + h01 + h11);
  float dxM = d * uTileSize;
  vec3 n1 = normalize(cross(vec3(dxM, 0.0, h10 - h00), vec3(0.0, dxM, h01 - h00)));
  vec3 n2 = normalize(cross(vec3(0.0, dxM, h11 - h10), vec3(-dxM, 0.0, h01 - h10)));
  vec3 N  = normalize(n1 + n2);
  float diff = clamp(dot(N, normalize(uSun)), 0.0, 1.0);

  float zReal = havg / max(uExag, 0.001);
  float slope = 1.0 - clamp(N.z, 0.0, 1.0);

  vec3 base = ramp(zReal);

  // Bare granite on steep terrain. Rogaland granite is pale cool grey, almost
  // off-white where freshly exposed, slightly darker/lichen-mottled lower down.
  vec3 rockLo = vec3(0.48, 0.49, 0.50); // wet/mossy granite low down
  vec3 rockHi = vec3(0.66, 0.68, 0.70); // pale Preikestolen / Kjerag granite
  vec3 rockCol = mix(rockLo, rockHi, smoothstep(150.0, 600.0, zReal));
  float rockMix = smoothstep(0.20, 0.50, slope);
  base = mix(base, rockCol, rockMix);

  // Snow above ~400 m; sticks only on gentler slopes.
  vec3 snow = vec3(0.94, 0.96, 0.99);
  float snowAlt   = smoothstep(380.0, 470.0, zReal);
  float snowSlope = 1.0 - smoothstep(0.28, 0.55, slope);
  float snowF = snowAlt * snowSlope;
  base = mix(base, snow, snowF);

  if (havg < 1.0) base = vec3(0.10, 0.18, 0.28);
  vec3 col = base * (0.40 + 0.70 * diff);
  // --- geology overlay (raster-textured, no separate mesh, no pokethrough) ---
  if (uBedShow > 0.5) {
    vec4 g = sampleGeo(uBedTex, uBedPalette, uBedPalN, vWorld.xy);
    col = mix(col, g.rgb * (0.40 + 0.70 * diff), g.a * uGeoOpacity);
  }
  if (uQuatShow > 0.5) {
    vec4 g = sampleGeo(uQuatTex, uQuatPalette, uQuatPalN, vWorld.xy);
    col = mix(col, g.rgb * (0.40 + 0.70 * diff), g.a * uGeoOpacity);
  }
  // --- contour lines (procedural iso-lines on the height field) ---
  if (uContourShow > 0.5) {
    float interval = max(uContourInterval, 0.001);
    float zReal = sampleH(vUv) / max(uExag, 0.001);
    float f = zReal / interval;
    float w = max(fwidth(f), 1e-5);
    float dist = abs(fract(f + 0.5) - 0.5);
    // anti-aliased line ~1.5 px wide
    float lineA = 1.0 - smoothstep(0.0, w * 0.75, dist);
    // density fade: kill lines when they'd merge into a wash
    float densityFade = 1.0 - smoothstep(0.4, 0.7, w);
    lineA *= densityFade;
    // bold "index" contour every Nth line
    float every = max(uContourBoldEvery, 1.0);
    float isBold = step(mod(floor(f + 0.5), every), 0.5);
    float boldA = (1.0 - smoothstep(0.0, w * 1.6, dist)) * densityFade * isBold;
    // smooth sea-level mask (avoids hard branch around fwidth)
    float landMask = smoothstep(0.5, 2.0, zReal);
    vec3 lineCol = mix(uContourColor, uContourBoldColor, isBold);
    float a = max(lineA * 0.55, boldA * 0.9) * uContourOpacity * landMask;
    col = mix(col, lineCol, a);
  }
  // --- roads (shader overlay; spatial-grid lookup of nearest OSM segment) ---
  if (uRoadShow > 0.5 && uRoadReady > 0.5) {
    vec2 p = vWorld.xy;
    vec2 cf = (p - uRoadOrigin) / uRoadCell;
    vec2 cellF = floor(cf);
    float minDist = 1e9;
    float minClsF = -1.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 c = cellF + vec2(float(dx), float(dy));
        if (c.x < 0.0 || c.y < 0.0 || c.x >= uRoadGridDims.x || c.y >= uRoadGridDims.y) continue;
        vec2 cellUV = vec2((c.x + 0.5) / uRoadGridDims.x, (c.y + 0.5) / uRoadGridDims.y);
        vec2 hdr = texture2D(uRoadGrid, cellUV).rg;
        float off = hdr.r;
        float cnt = hdr.g;
        for (int k = 0; k < 128; k++) {
          if (float(k) >= cnt) break;
          float ri = off + float(k);
          vec2 ruv = _refUV(ri);
          vec4 s = texture2D(uRoadRefs, ruv);
          float d = _distSeg(p, s.xy, s.zw);
          if (d < minDist) {
            minDist = d;
            minClsF = floor(texture2D(uRoadCls, ruv).r * 255.0 + 0.5);
          }
        }
      }
    }
    if (minClsF >= 0.0) {
      int minCls = int(minClsF);
      float halfW = (minCls == 0) ? 6.5 :
                    (minCls == 1) ? 5.0 :
                    (minCls == 2) ? 4.0 :
                    (minCls == 3) ? 3.25 : 2.75;
      float aaw = max(fwidth(minDist), 0.25);
      float coreT = 1.0 - smoothstep(halfW - aaw, halfW + aaw, minDist);
      vec3 coreCol = (minCls == 0) ? vec3(0.165, 0.165, 0.175) :
                     (minCls == 1) ? vec3(0.180, 0.180, 0.185) :
                     (minCls == 2) ? vec3(0.210, 0.205, 0.180) :
                     (minCls == 3) ? vec3(0.225, 0.215, 0.195) :
                                     vec3(0.240, 0.225, 0.205);
      // subtle per-metre hash grain to break up flat asphalt
      float grain = fract(sin(dot(floor(vWorld.xy), vec2(12.9898, 78.233))) * 43758.5453);
      coreCol *= (0.90 + 0.18 * grain);
      vec3 roadShaded = coreCol * (0.40 + 0.70 * diff);
      // Thin lighter shoulder for motorways/trunks
      if (minCls <= 1) {
        float edgeHi = halfW + 0.6;
        float edgeT = (1.0 - smoothstep(edgeHi - aaw, edgeHi + aaw, minDist)) - coreT;
        edgeT = clamp(edgeT, 0.0, 1.0);
        vec3 edgeCol = vec3(0.55, 0.54, 0.50) * (0.40 + 0.70 * diff);
        col = mix(col, edgeCol, edgeT * 0.85);
      }
      col = mix(col, roadShaded, coreT);
    }
  }
  // distance fog
  float fogF = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
  col = mix(col, uFogColor, fogF);
  gl_FragColor = vec4(col, 1.0);
}
`;
