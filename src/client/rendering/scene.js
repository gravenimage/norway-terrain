/**
 * @file Constructs the shared Three.js renderer, scene graph, camera, controls, and layer groups for the viewer.
 */

/**
 * Creates the viewer scene bundle and returns shared references used by rendering, terrain, and feature systems.
 * The function centralizes ownership of the scene, camera, renderer, controls, and groups so the render loop can borrow them without recreating resources.
 */
export function createViewerScene({ THREE, MapControls, canvas, meta }) {
  const ROOT_SIZE = meta.rootSize ?? meta.size;

  if (THREE.Object3D?.DEFAULT_UP) {
    THREE.Object3D.DEFAULT_UP.set(0,0,1);
  }

  const rendererOptions = { antialias:true, powerPreference:'high-performance', logarithmicDepthBuffer: true };
  if (canvas) rendererOptions.canvas = canvas;
  const renderer = new THREE.WebGLRenderer(rendererOptions);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (!canvas && globalThis.document?.body) {
    document.body.appendChild(renderer.domElement);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1322);
  const FOG_NEAR = ROOT_SIZE*0.5, FOG_FAR = ROOT_SIZE*1.6;
  const FOG_COLOR = new THREE.Color(0x0c1322);
  scene.fog = new THREE.Fog(0x0c1322, FOG_NEAR, FOG_FAR);

  const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 50, ROOT_SIZE*4);
  camera.up.set(0,0,1);
  camera.position.set(0, -120000, 90000);

  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 200;
  controls.maxDistance = ROOT_SIZE*2;
  controls.maxPolarAngle = Math.PI*0.49;
  controls.zoomSpeed = 1.6;

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOT_SIZE*1.5, ROOT_SIZE*1.5),
    new THREE.MeshBasicMaterial({ color: 0x123048 })
  );
  water.position.z = 1.0;
  water.renderOrder = -1;
  scene.add(water);

  const roadsGroup = new THREE.Group();
  const townsGroup = new THREE.Group();
  scene.add(roadsGroup);
  scene.add(townsGroup);

  const buildingsGroup = new THREE.Group();
  scene.add(buildingsGroup);

  const amenitiesGroup = new THREE.Group();
  scene.add(amenitiesGroup);

  const treesGroup = new THREE.Group();
  scene.add(treesGroup);

  const canopyGroup = new THREE.Group();
  scene.add(canopyGroup);

  const faultsGroup = new THREE.Group();
  faultsGroup.visible = false;
  scene.add(faultsGroup);

  const SUN = new THREE.Vector3(-0.4, -0.6, 0.85).normalize();

  /**
   * Resizes the shared camera projection and renderer backbuffer to match the browser viewport.
   * Keeping this as a returned method lets the application wire resize events without exposing scene construction details.
   */
  function resize() {
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  return {
    scene,
    camera,
    controls,
    renderer,
    groups: {
      water,
      roadsGroup,
      townsGroup,
      buildingsGroup,
      amenitiesGroup,
      treesGroup,
      canopyGroup,
      faultsGroup,
    },
    resize,
    fog: { near: FOG_NEAR, far: FOG_FAR, color: FOG_COLOR },
    sun: SUN,
  };
}
