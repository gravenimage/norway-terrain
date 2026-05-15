/**
 * @file Forest generation Web Worker. Owns the 27-second CPU-bound K_TREES
 * expansion loop so the main thread stays interactive (smooth pan/zoom)
 * during boot. Imports the pure parse/generate/obstacle modules; never
 * touches THREE.
 *
 * Protocol (see features/forest.js for the main-thread counterpart):
 *   worker → main  {type:'ready'}                    (sent once on script load)
 *   main → worker  {type:'generate', forestBuffer, obstacles}
 *   worker → main  {type:'progress', current, total} (periodic)
 *   worker → main  {type:'bin', cellCx, cellCy, radius, maxH, instanceCount,
 *                   seedCount, iPos, iSize, iRot, iCanopyA, iCanopyB}
 *                  (per bin; all five Float32Arrays sent as transferables)
 *   worker → main  {type:'done', summary}            (final, with aggregate stats)
 *   worker → main  {type:'error', message}           (on parse/generate failure)
 */

import { generateForestBins } from '../features/forest-generate.js';

function postBin(payload) {
  const transfer = [
    payload.iPos.buffer,
    payload.iSize.buffer,
    payload.iRot.buffer,
    payload.iCanopyA.buffer,
    payload.iCanopyB.buffer,
  ];
  self.postMessage({ type: 'bin', ...payload }, transfer);
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'generate') return;
  try {
    const PROGRESS_EVERY_MS = 250;
    let lastProgressMs = 0;
    const summary = generateForestBins({
      forestBuffer: msg.forestBuffer,
      obstacleState: msg.obstacles,
      onBin: (bin) => postBin(bin),
      onProgress: (current, total) => {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now - lastProgressMs >= PROGRESS_EVERY_MS || current === total) {
          lastProgressMs = now;
          self.postMessage({ type: 'progress', current, total });
        }
      },
    });
    self.postMessage({ type: 'done', summary });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
});

// Ready handshake: lets the main thread know the worker has imported its
// modules and is ready to receive a generate message. The main thread waits
// for this before transferring the 94 MB forest buffer so a worker-import
// failure doesn't leave it without a path to load trees.
self.postMessage({ type: 'ready' });
