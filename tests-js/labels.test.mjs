// Tests for src/client/features/labels.js — covers the pure parsing and culling helpers.
// The full createLabelSystem() needs THREE + canvas APIs so it's smoke-tested with stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFeaturesJson, pickVisibleIndices, createLabelSystem } from '../src/client/features/labels.js';

test('parseFeaturesJson normalises feature shape', () => {
  const out = parseFeaturesJson({
    features: [
      { name: 'Stavanger', kind: 'town', rank: 1, x: -3000, y: 4000, z: 12 },
      { name: 'Storfjellet', kind: 'peak', rank: 10, x: 1500, y: -2500, z: 850 },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Stavanger');
  assert.equal(out[0].kind, 'town');
  assert.equal(out[1].z, 850);
});

test('parseFeaturesJson throws on missing features array', () => {
  assert.throws(() => parseFeaturesJson({}), /features.json/);
  assert.throws(() => parseFeaturesJson(null), /features.json/);
});

test('pickVisibleIndices returns only features within radius', () => {
  const features = [
    { name: 'a', kind: 'town', rank: 0, x: 0, y: 0, z: 0 },        // at camera
    { name: 'b', kind: 'town', rank: 0, x: 1000, y: 0, z: 0 },     // 1 km east
    { name: 'c', kind: 'town', rank: 0, x: 2500, y: 0, z: 0 },     // 2.5 km east (out)
    { name: 'd', kind: 'town', rank: 0, x: 0, y: -1800, z: 0 },    // 1.8 km south
  ];
  const visible = pickVisibleIndices(features, 0, 0, 2000 * 2000);
  assert.deepEqual(visible.sort(), [0, 1, 3]);
});

test('pickVisibleIndices respects camera position', () => {
  const features = [
    { name: 'a', kind: 'town', rank: 0, x: 0, y: 0, z: 0 },
    { name: 'b', kind: 'town', rank: 0, x: 5000, y: 0, z: 0 },
  ];
  // camera at (5000, 0): only 'b' is in range.
  const visible = pickVisibleIndices(features, 5000, 0, 2000 * 2000);
  assert.deepEqual(visible, [1]);
});

// --- createLabelSystem smoke test with a minimal THREE stub. We don't render anything; we
// just exercise the lifecycle and culling pipeline so refactors that break the contract fail.
function makeStubTHREE() {
  class Group {
    constructor() { this.children = []; this.visible = true; }
    add(child) { this.children.push(child); }
  }
  class Sprite {
    constructor(material) {
      this.material = material;
      this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.scale = { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.visible = true;
    }
  }
  class SpriteMaterial { constructor(opts) { Object.assign(this, opts); } }
  class CanvasTexture { constructor(cvs) { this.image = cvs; this.needsUpdate = false; } }
  return {
    Group, Sprite, SpriteMaterial, CanvasTexture,
    NearestFilter: 'NearestFilter',
  };
}

function ensureCanvasShim() {
  if (typeof globalThis.document !== 'undefined') return;
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`stub document only knows canvas, got ${tag}`);
      return {
        width: 0, height: 0,
        getContext() {
          return {
            font: '',
            textBaseline: '',
            fillStyle: '',
            imageSmoothingEnabled: true,
            measureText(s) { return { width: s.length * 6 }; },
            fillRect() {},
            fillText() {},
          };
        },
      };
    },
  };
}

test('createLabelSystem materialises sprites lazily within range and hides them out of range', () => {
  ensureCanvasShim();
  const THREE = makeStubTHREE();
  const scene = new THREE.Group();
  const system = createLabelSystem({ THREE, scene, getExag: () => 1.5 });

  // Inject features without going through load() / fetch.
  const features = [
    { name: 'Near', kind: 'town', rank: 0, x: 100, y: 0, z: 10 },
    { name: 'Far',  kind: 'town', rank: 0, x: 9000, y: 0, z: 5 },
  ];
  system._internal.getFeatures().length = 0;
  features.forEach((f) => system._internal.getFeatures().push(f));
  // Reset sprite slots to match the injected features.
  const sprites = system._internal.getSprites();
  sprites.length = 0;
  sprites.push(null, null);

  const camera = { position: { x: 0, y: 0, z: 0 } };
  system.update(camera);

  // 'Near' should now have a sprite, 'Far' should not yet (it's >2 km away).
  assert.ok(sprites[0], 'near feature should be materialised');
  assert.equal(sprites[1], null, 'far feature should not be materialised');
  // Z should track exag: z=10 * exag=1.5 + 75 = 90.
  assert.equal(sprites[0].position.z, 10 * 1.5 + 75);
  assert.equal(sprites[0].visible, true);

  // Move camera to put the far feature in range, near feature out of range.
  camera.position.x = 9000;
  system.update(camera);
  assert.ok(sprites[1], 'far feature should now be materialised');
  assert.equal(sprites[0].visible, false, 'previously-near feature should be hidden');
  assert.equal(sprites[1].visible, true);
});

test('createLabelSystem updates sprite Z when exag changes', () => {
  ensureCanvasShim();
  const THREE = makeStubTHREE();
  const scene = new THREE.Group();
  let exag = 1.0;
  const system = createLabelSystem({ THREE, scene, getExag: () => exag });
  const features = [{ name: 'Test', kind: 'peak', rank: 10, x: 0, y: 0, z: 100 }];
  system._internal.getFeatures().push(...features);
  system._internal.getSprites().push(null);

  const camera = { position: { x: 0, y: 0, z: 0 } };
  system.update(camera);
  const sprite = system._internal.getSprites()[0];
  assert.equal(sprite.position.z, 100 * 1.0 + 75);

  exag = 2.5;
  system.setExag(exag);
  system.update(camera);
  assert.equal(sprite.position.z, 100 * 2.5 + 75);
});

test('createLabelSystem setVisible toggles the group', () => {
  ensureCanvasShim();
  const THREE = makeStubTHREE();
  const scene = new THREE.Group();
  const system = createLabelSystem({ THREE, scene });
  const group = system._internal.group;
  assert.equal(group.visible, true);
  system.setVisible(false);
  assert.equal(group.visible, false);
  system.setVisible(true);
  assert.equal(group.visible, true);
});
