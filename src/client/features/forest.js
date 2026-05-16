/** @file TRE1/TRE2 forest stateful tree/canopy scene system. Parsing lives in features/forest-parse.js so the Web Worker can import the parser without dragging THREE-dependent code. */
import { FOREST_CONTRACT, parseForestBuffer } from './forest-parse.js';
export { FOREST_CONTRACT, parseForestBuffer };
import { parseCanopyBuffer } from './canopy.js';
import { createNullObstacles } from '../services/spatial-index.js';
import {
  CANOPY_RANGE_FADE_FLOOR_FRACTION,
  CANOPY_RANGE_INNER_DELTA_METRES,
} from '../core/constants.js';
import { computeFadeRange } from '../core/lod-fade.js';
import { makeBudget, yieldToBrowser } from '../core/yield.js';

const NOW = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

/**
 * Spawn the forest worker, wait for its 'ready' handshake, transfer the forest
 * buffer + obstacle snapshots, and stream per-bin results back to `onBin`.
 *
 * Return-value contract (intentional, see rubber-duck review):
 *   true  → worker generated successfully. `onSummary(summary)` was called,
 *           `onBin` was called once per bin; `forestBuffer` was transferred.
 *   false → worker spawn or ready handshake failed BEFORE any transfer. The
 *           caller still owns forestBuffer and should run the inline fallback.
 *   throws → worker errored AFTER transfer. forestBuffer is detached;
 *           recovery is impossible, so the caller's outer catch handles it.
 *
 * The 3 s ready timeout is generous: module worker import normally completes
 * in tens of milliseconds, but the timeout protects against pathological cases
 * (e.g. server hangs on the worker module fetch).
 */
async function generateInWorker({ forestBuffer, obstacles, progress, onBin, onSummary }) {
  if (typeof Worker === 'undefined') return false;
  let worker;
  try {
    worker = new Worker(new URL('../workers/forest-worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[forest] worker spawn failed:', err);
    return false;
  }
  // Ready handshake. Resolves true once 'ready' arrives, false on timeout.
  const READY_TIMEOUT_MS = 3000;
  const ready = await new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      console.warn('[forest] worker ready handshake timed out after', READY_TIMEOUT_MS, 'ms');
      resolve(false);
    }, READY_TIMEOUT_MS);
    worker.addEventListener('message', function readyOnce(e) {
      if (e.data && e.data.type === 'ready' && !resolved) {
        resolved = true;
        clearTimeout(timer);
        worker.removeEventListener('message', readyOnce);
        resolve(true);
      }
    });
    worker.addEventListener('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      console.warn('[forest] worker errored before ready:', err.message || err);
      resolve(false);
    });
  });
  if (!ready) {
    worker.terminate();
    return false;
  }
  // Post-ready: serialize obstacles (cloned via .slice() so the main thread
  // keeps its live copies), then transfer forestBuffer + obstacle buffers in
  // one message. From this point forestBuffer is detached on the main thread
  // and a worker failure is unrecoverable for this load attempt.
  const snapshot = obstacles.serializeForWorker
    ? obstacles.serializeForWorker()
    : { roads: null, buildings: null };
  const transfers = [forestBuffer];
  if (obstacles.collectTransferables) {
    for (const buf of obstacles.collectTransferables(snapshot)) transfers.push(buf);
  }
  return new Promise((resolve, reject) => {
    worker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'bin') {
        onBin(msg);
      } else if (msg.type === 'progress') {
        progress.update('forest-trees', { current: msg.current, total: msg.total });
      } else if (msg.type === 'done') {
        onSummary(msg.summary);
        worker.terminate();
        resolve(true);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error('forest worker error: ' + msg.message));
      }
    });
    worker.addEventListener('error', (err) => {
      worker.terminate();
      reject(new Error('forest worker runtime error: ' + (err.message || err)));
    });
    try {
      worker.postMessage({ type: 'generate', forestBuffer, obstacles: snapshot }, transfers);
    } catch (postErr) {
      worker.terminate();
      reject(postErr);
    }
  });
}

/**
 * No-op progress tracker used when the system is constructed without one (e.g.
 * tests). Keeps the loader code free of conditional checks.
 */
const NULL_PROGRESS = {
  start() {}, update() {}, finish() {}, error() {},
};

/**
 * Create the coupled forest/canopy renderer. THREE, groups, and uniforms are
 * shared references; treeCells/canopyCells and LOD state are owned here. Scene
 * is accepted for API symmetry. Uniforms are mutated in place, loadTrees() and
 * loadCanopy() are fire-and-forget, and updateForGeology couples forest
 * visibility to geology overlays.
 */
export function createForestSystem({ THREE, scene, treesGroup, canopyGroup, treeUniforms, canopyUniforms, elevationMax = 14835, obstacles = createNullObstacles(), progress = NULL_PROGRESS }) {
  void scene;
  const treeCells = [];
  const canopyCells = [];
  const cellSphere = THREE.Sphere ? new THREE.Sphere() : null;
  const cellCenter = THREE.Vector3 ? new THREE.Vector3() : null;
  let visibleWanted = true;
  let geologyVisible = false;
  let canopyLodLo = canopyUniforms.uFadeNear.value;
  let canopyLodHi = canopyUniforms.uFadeFar.value;
  let canopyRange = canopyUniforms.uRangeFar.value;

  /**
   * Apply the forest + geology invariant: tree and canopy groups are visible
   * only when requested and no bedrock/quaternary geology overlay is active.
   */
  function applyVisibility() {
    const visible = visibleWanted && !geologyVisible;
    treesGroup.visible = visible;
    canopyGroup.visible = visible;
  }

  return {
    /**
     * FeatureSystem.load() — fire both forest sub-loads in parallel. Replaces
     * the paired loadTrees + loadCanopy calls; either can still be invoked
     * individually for tests or partial loading.
     */
    async load() {
      await Promise.all([this.loadTrees(), this.loadCanopy()]);
    },
    /**
     * Fire-and-forget loadTrees() for forest.bin: parses TRE1/TRE2 seeds,
     * expands each seed into K_TREES=16 instances over a 48 m quad with a 1.2 m
     * base sink, creates one instanced mesh per 4000 m bin, and records culling
     * bounds. Initial tree visibility is limited by canopyLodHi.
     */
    async loadTrees() {
      const phaseTimings = { fetch: 0, waitObstacles: 0, generate: 0 };
      const tFetchStart = NOW();
      progress.start('forest-trees', 'Forest');
      progress.update('forest-trees', { phase: 'fetching forest.bin' });
      try {
        const [{ makeTreeGeometry }, materials, ab] = await Promise.all([
          import('./geometry-builders.js'),
          import('../rendering/material-factory.js'),
          (await fetch('forest.bin')).arrayBuffer(),
        ]);
        phaseTimings.fetch = NOW() - tFetchStart;
        progress.update('forest-trees', { phase: 'waiting for road/building footprints' });
        const tWaitStart = NOW();
        // Wait for road and building footprints to be ready (or marked empty) so the per-instance
        // cull in the worker (or inline fallback) sees a complete obstacle map. Tree generation
        // runs once at startup and is non-trivial, so the small extra latency is preferable to
        // leaking trees onto roads / through roofs.
        await Promise.all([obstacles.roadsReady, obstacles.buildingsReady]);
        phaseTimings.waitObstacles = NOW() - tWaitStart;

        const treeGeom = makeTreeGeometry();
        const treeMaterial = materials.createTreeMaterial(treeUniforms);
        const K_TREES = 16;
        let totalInstances = 0;
        let totalCells = 0;
        let summaryFromGen = null;
        // Main-thread instrumentation: distinct from worker generate time. Most
        // bin work happens during postMessage tasks while the worker is still
        // running, so this should be small and spread out. If `mainThreadMs`
        // is large, mesh creation itself is the bottleneck; if `maxBatchMs`
        // is large, bins are arriving in bursts that need draining.
        let mainThreadMs = 0;
        let maxBatchMs = 0;
        let firstBinAtMs = null;
        let lastBinAtMs = null;

        /**
         * Build the InstancedBufferGeometry + Mesh for one bin and register it
         * for culling. Records its own runtime so we can see whether mesh
         * creation is what's blocking the main thread.
         */
        function addBinMesh(bin) {
          const tBin = NOW();
          if (firstBinAtMs === null) firstBinAtMs = tBin;
          const aPos     = new THREE.InstancedBufferAttribute(bin.iPos, 3);
          const aSize    = new THREE.InstancedBufferAttribute(bin.iSize, 2);
          const aRot     = new THREE.InstancedBufferAttribute(bin.iRot, 1);
          const aCanopyA = new THREE.InstancedBufferAttribute(bin.iCanopyA, 3);
          const aCanopyB = new THREE.InstancedBufferAttribute(bin.iCanopyB, 3);
          const ig = new THREE.InstancedBufferGeometry();
          ig.setAttribute('position', treeGeom.getAttribute('position'));
          ig.setAttribute('normal',   treeGeom.getAttribute('normal'));
          ig.setAttribute('aPart',    treeGeom.getAttribute('aPart'));
          ig.setAttribute('iPos',     aPos);
          ig.setAttribute('iSize',    aSize);
          ig.setAttribute('iRot',     aRot);
          ig.setAttribute('iCanopyA', aCanopyA);
          ig.setAttribute('iCanopyB', aCanopyB);
          ig.instanceCount = bin.instanceCount;
          const mesh = new THREE.Mesh(ig, treeMaterial);
          mesh.frustumCulled = false;
          mesh.renderOrder = 1;
          treesGroup.add(mesh);
          treeCells.push({ mesh, cx: bin.cellCx, cy: bin.cellCy, radius: bin.radius, maxH: bin.maxH, count: bin.seedCount });
          totalInstances += bin.instanceCount;
          totalCells += 1;
          const dt = NOW() - tBin;
          mainThreadMs += dt;
          if (dt > maxBatchMs) maxBatchMs = dt;
          lastBinAtMs = NOW();
        }

        // Try the worker path first. The worker imports forest-generate +
        // forest-parse + obstacles-query (no THREE) and sends a 'ready' message
        // on module load — the main thread waits for that handshake before
        // transferring the 94 MB forest buffer so an import failure leaves the
        // main thread free to fall back without losing the buffer.
        const tGenerateStart = NOW();
        const workerOK = await generateInWorker({
          forestBuffer: ab,
          obstacles,
          progress,
          onBin: addBinMesh,
          onSummary: (s) => { summaryFromGen = s; },
        });
        if (!workerOK) {
          // Inline synchronous fallback: blocks the main thread for ~25 s but at
          // least the trees appear. Reserved for worker spawn failure or ready
          // timeout, which should be rare on modern browsers.
          const { generateForestBins } = await import('./forest-generate.js');
          const snapshot = obstacles.serializeForWorker
            ? obstacles.serializeForWorker()
            : { roads: null, buildings: null };
          summaryFromGen = generateForestBins({
            forestBuffer: ab,
            obstacleState: snapshot,
            onBin: addBinMesh,
            onProgress: (current, total) => progress.update('forest-trees', { current, total }),
          });
        }
        phaseTimings.generate = NOW() - tGenerateStart;

        const K = (summaryFromGen && summaryFromGen.K_TREES) || K_TREES;
        const n = summaryFromGen ? summaryFromGen.seeds : 0;
        const totalCulled = summaryFromGen ? summaryFromGen.culled : 0;
        const attrMB = (totalInstances * 48) / (1024 * 1024);
        const summary = {
          seeds: n,
          instances: totalInstances,
          culled: totalCulled,
          cells: totalCells,
          attrMB: Number(attrMB.toFixed(1)),
          fetchMs: Number(phaseTimings.fetch.toFixed(0)),
          waitObstaclesMs: Number(phaseTimings.waitObstacles.toFixed(0)),
          generateMs: Number(phaseTimings.generate.toFixed(0)),
          workerUsed: workerOK,
          mainThreadMs: Number(mainThreadMs.toFixed(0)),
          maxBatchMs: Number(maxBatchMs.toFixed(1)),
          firstBinMs: firstBinAtMs !== null ? Number((firstBinAtMs - tGenerateStart).toFixed(0)) : null,
          lastBinMs: lastBinAtMs !== null ? Number((lastBinAtMs - tGenerateStart).toFixed(0)) : null,
          isBlockedCalls: summaryFromGen ? summaryFromGen.isBlockedCalls : 0,
          seedsSkippedByPrecheck: summaryFromGen ? summaryFromGen.seedsSkippedByPrecheck : 0,
        };
        console.info(
          `[forest] loadTrees done: fetch=${summary.fetchMs}ms wait=${summary.waitObstaclesMs}ms generate=${summary.generateMs}ms mainThread=${summary.mainThreadMs}ms maxBatch=${summary.maxBatchMs}ms firstBin=${summary.firstBinMs}ms lastBin=${summary.lastBinMs}ms (worker=${summary.workerUsed}, isBlocked calls=${summary.isBlockedCalls.toLocaleString()}, ${summary.seedsSkippedByPrecheck.toLocaleString()}/${summary.seeds.toLocaleString()} seeds skipped by pre-check) — ${summary.instances.toLocaleString()} instances in ${summary.cells} cells, ${summary.attrMB} MB attrs, ${summary.culled.toLocaleString()} culled`,
          summary,
        );
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>trees: ${totalInstances.toLocaleString()} (×${K} from ${n.toLocaleString()} seeds, ${totalCulled.toLocaleString()} culled on roads/buildings) in ${totalCells} cells, < ${(canopyLodHi/1000).toFixed(1)} km`);
        progress.finish('forest-trees');
        return;
      } catch (e) {
        console.warn('forest.bin not loaded:', e);
        progress.error('forest-trees', e && e.message ? e.message : String(e));
      }
    },
    /**
     * Fire-and-forget loadCanopy() for canopy.bin: parses CANO cells, creates one
     * THREE.BufferGeometry mesh per cell, adds meshes to canopyGroup, and stores
     * cell bounds for LOD/range culling.
     */
    async loadCanopy() {
      progress.start('forest-canopy', 'Canopy');
      progress.update('forest-canopy', { phase: 'fetching canopy.bin' });
      const tFetchStart = NOW();
      try {
        const [materials, ab] = await Promise.all([
          import('../rendering/material-factory.js'),
          (await fetch('canopy.bin')).arrayBuffer(),
        ]);
        const fetchMs = NOW() - tFetchStart;
        progress.update('forest-canopy', { phase: 'parsing' });
        const tParseStart = NOW();
        const canopyMaterial = materials.createCanopyMaterial(canopyUniforms);
        const parsed = parseCanopyBuffer(ab);
        const parseMs = NOW() - tParseStart;
        const tBuildStart = NOW();
        const cells = parsed.cells;
        progress.update('forest-canopy', { phase: 'building cells', total: cells.length });
        const budget = makeBudget(8);
        for (let i = 0; i < cells.length; i += 1) {
          const { kx, ky, cx, cy, czMin, czMax, radius, verts, indices } = cells[i];
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
          geom.setIndex(new THREE.BufferAttribute(indices, 1));
          const mesh = new THREE.Mesh(geom, canopyMaterial);
          mesh.frustumCulled = false;
          mesh.renderOrder = 1;
          canopyGroup.add(mesh);
          canopyCells.push({ mesh, cx, cy, czMin, czMax, radius, kx, ky });
          if (budget.exceeded() && i + 1 < cells.length) {
            progress.update('forest-canopy', { current: i + 1 });
            await yieldToBrowser();
            budget.reset();
          }
        }
        const buildMs = NOW() - tBuildStart;
        console.info(
          `[forest] loadCanopy done: fetch=${Number(fetchMs.toFixed(0))}ms parse=${Number(parseMs.toFixed(0))}ms build=${Number(buildMs.toFixed(0))}ms — ${parsed.nCells} cells, ${parsed.totalTris.toLocaleString()} tris`,
        );
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>canopy: ${parsed.nCells} cells, ${parsed.totalTris.toLocaleString()} tris`);
        progress.finish('forest-canopy');
      } catch (e) {
        console.warn('canopy.bin not loaded:', e);
        progress.error('forest-canopy', e && e.message ? e.message : String(e));
      }
    },
    /**
     * Update tree and canopy cell visibility. Trees render below canopyLodHi;
     * canopy cells render when beyond canopyLodLo and nearer than canopyRange,
     * with all tests using elevation-inflated frustum spheres.
     */
    cull({ camera, frustum }) {
      if (!cellCenter || !cellSphere) return;
      const exag = treeUniforms.uExag.value;
      if (!treesGroup.visible){
        for (const c of treeCells){ c.mesh.visible = false; }
      } else {
        for (const c of treeCells){
          cellCenter.set(c.cx, c.cy, elevationMax*exag*0.5);
          cellSphere.center.copy(cellCenter);
          cellSphere.radius = c.radius + elevationMax*exag*0.5 + c.maxH;
          const dist = camera.position.distanceTo(cellCenter);
          const near = dist - c.radius;
          const inFrustumNow = frustum.intersectsSphere(cellSphere);
          c.mesh.visible = inFrustumNow && near < canopyLodHi;
        }
      }
      if (!canopyGroup.visible){
        for (const c of canopyCells){ c.mesh.visible = false; }
        return;
      }
      for (const c of canopyCells){
        const cz = (c.czMin + c.czMax) * 0.5 * exag + 4.0;
        cellCenter.set(c.cx, c.cy, cz);
        cellSphere.center.copy(cellCenter);
        cellSphere.radius = c.radius + (c.czMax - c.czMin) * exag * 0.5 + 18.0;
        const dist = camera.position.distanceTo(cellCenter);
        const near = dist - c.radius;
        const far  = dist + c.radius;
        const inFrustumNow = frustum.intersectsSphere(cellSphere);
        c.mesh.visible = inFrustumNow && far > canopyLodLo && near < canopyRange;
      }
    },
    /**
     * Record requested forest visibility and reapply the geology coupling so
     * geology overlays can still suppress tree and canopy groups.
     */
    setVisible(visible) {
      visibleWanted = visible;
      applyVisibility();
    },
    /**
     * Mutate canopy range uniforms in place. Far equals rangeMetres and near is
     * max(rangeMetres - 2000, rangeMetres * 0.85), the canopy range fade window.
     */
    setRange(rangeMetres) {
      canopyRange = rangeMetres;
      canopyUniforms.uRangeFar.value  = canopyRange;
      canopyUniforms.uRangeNear.value = computeFadeRange(canopyRange, {
        bandMetres: CANOPY_RANGE_INNER_DELTA_METRES,
        floorFraction: CANOPY_RANGE_FADE_FLOOR_FRACTION,
      });
    },
    /**
     * Mutate tree/canopy LOD uniforms in place and update owned thresholds:
     * canopyLodLo hides canopy too near the camera, canopyLodHi caps tree range.
     */
    setLodSwitch(loMetres, hiMetres) {
      canopyLodLo = loMetres;
      canopyLodHi = hiMetres;
      treeUniforms.uFadeNear.value   = canopyLodLo;
      treeUniforms.uFadeFar.value    = canopyLodHi;
      canopyUniforms.uFadeNear.value = canopyLodLo;
      canopyUniforms.uFadeFar.value  = canopyLodHi;
    },
    /**
     * Mutate shared tree and canopy exaggeration uniforms in place so both
     * forest layers track terrain scale together.
     */
    setExaggeration(value) {
      treeUniforms.uExag.value = value;
      canopyUniforms.uExag.value = value;
    },
    /**
     * Coupling hook from the geology system: any visible bedrock or quaternary
     * overlay suppresses forest and canopy visibility until overlays are hidden.
     */
    updateForGeology({ bedrockVisible, quaternaryVisible }) {
      geologyVisible = Boolean(bedrockVisible) || Boolean(quaternaryVisible);
      applyVisibility();
    },
  };
}
