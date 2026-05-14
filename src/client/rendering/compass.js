/**
 * @file Builds and renders the orientation compass overlay for the viewer.
 */

/**
 * Creates a small independent compass scene that mirrors the shared main camera orientation.
 * The renderer and camera are borrowed references, so the compass restores renderer state after drawing its overlay viewport.
 */
export function createCompass({ THREE, renderer, camera }) {
  const compassScene = new THREE.Scene();
  const compassCam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  compassCam.up.set(0,0,1);
  compassScene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const _compassLight = new THREE.DirectionalLight(0xffffff, 0.9);
  _compassLight.position.set(2, 3, 4);
  compassScene.add(_compassLight);

  const compassArrow = new THREE.Group();

  // Flat extruded arrow shape in the XY plane (points +Y = north).
  const _arrowShape = new THREE.Shape();
  _arrowShape.moveTo(-0.12, -0.9);
  _arrowShape.lineTo( 0.12, -0.9);
  _arrowShape.lineTo( 0.12,  0.4);
  _arrowShape.lineTo( 0.36,  0.4);
  _arrowShape.lineTo( 0.00,  1.05);
  _arrowShape.lineTo(-0.36,  0.4);
  _arrowShape.lineTo(-0.12,  0.4);
  _arrowShape.lineTo(-0.12, -0.9);
  const _arrowGeom = new THREE.ExtrudeGeometry(_arrowShape, {
    depth: 0.10,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.015,
    bevelSegments: 2,
    curveSegments: 1,
  });
  // Toon-style: each face a uniform colour band with a clean step gradient.
  const _toonGradient = (() => {
    const d = new Uint8Array([90,90,90,255, 200,200,200,255, 255,255,255,255]);
    const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    return t;
  })();
  const _arrowMat = new THREE.MeshToonMaterial({
    color: 0xffd21a,
    gradientMap: _toonGradient,
  });
  _arrowMat.flatShading = true;
  _arrowMat.polygonOffset = true;
  _arrowMat.polygonOffsetFactor = 1;
  _arrowMat.polygonOffsetUnits = 1;
  const _arrowMesh = new THREE.Mesh(_arrowGeom, _arrowMat);
  compassArrow.add(_arrowMesh);

  // Thin black outline along sharp edges.
  const _arrowEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(_arrowGeom, 18),
    new THREE.LineBasicMaterial({ color: 0x000000 })
  );
  compassArrow.add(_arrowEdges);

  // "N" label as a sprite at the tip, in the same depth space (so the arrow can occlude it).
  const _nCanvas = document.createElement('canvas');
  _nCanvas.width = 96; _nCanvas.height = 96;
  {
    const c = _nCanvas.getContext('2d');
    c.clearRect(0, 0, 96, 96);
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#000000';
    c.lineWidth = 6;
    c.font = 'bold 72px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.strokeText('N', 48, 52);
    c.fillText('N', 48, 52);
  }
  const _nTex = new THREE.CanvasTexture(_nCanvas);
  _nTex.colorSpace = THREE.SRGBColorSpace;
  _nTex.anisotropy = 4;
  const _nSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _nTex, depthTest: true, depthWrite: false, transparent: true,
  }));
  _nSprite.scale.set(0.34, 0.34, 1);
  // Sit the label at the tip, centred in the arrow's thickness so the arrow body can occlude it.
  _nSprite.position.set(0, 1.32, 0.05);
  compassArrow.add(_nSprite);

  compassScene.add(compassArrow);

  const COMPASS_SIZE_PX = 140;
  const COMPASS_PAD_PX = 16;
  const COMPASS_DIST = 3.4;
  const _compassFwd = new THREE.Vector3();

  /**
   * Renders the compass after the main scene so it appears as an overlay without clearing the frame.
   * It copies the shared camera orientation each frame and restores viewport, scissor, and autoClear state for the rest of the viewer.
   */
  function render() {
    // Mirror main camera orientation around the arrow's origin so visual north matches.
    _compassFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    compassCam.position.copy(_compassFwd).multiplyScalar(-COMPASS_DIST);
    compassCam.quaternion.copy(camera.quaternion);
    compassCam.updateMatrixWorld();

    const s = COMPASS_SIZE_PX;
    const x = COMPASS_PAD_PX;
    const y = COMPASS_PAD_PX; // GL origin is bottom-left, so this places it at bottom-left
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, s, s);
    renderer.setScissor(x, y, s, s);
    renderer.clearDepth();
    renderer.render(compassScene, compassCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.autoClear = prevAutoClear;
  }

  return { render };
}
