/**
 * @file Forest generation Web Worker. Owns the 27-second CPU-bound K_TREES
 * expansion loop so the main thread stays interactive (smooth pan/zoom)
 * during boot. Imports the pure parse/generate/obstacle modules; never
 * touches THREE.
 *
 * Protocol message types and the bin payload shape live in
 * features/forest-protocol.js so the main thread and worker can't drift on
 * magic strings.
 */

import { generateForestBins } from '../features/forest-generate.js';
import {
  FWR_BIN, FWR_DONE, FWR_ERROR, FWR_PROGRESS, FWR_READY, FWS_GENERATE,
} from '../features/forest-protocol.js';

function postBin(payload) {
  const transfer = [
    payload.iPos.buffer,
    payload.iSize.buffer,
    payload.iRot.buffer,
    payload.iCanopyA.buffer,
    payload.iCanopyB.buffer,
  ];
  self.postMessage({ type: FWR_BIN, ...payload }, transfer);
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== FWS_GENERATE) return;
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
          // Progress is best-effort: if the channel has closed (e.g. main
          // thread terminated us mid-flight) swallow the throw so we don't
          // turn a cleanup race into an FWR_ERROR.
          try { self.postMessage({ type: FWR_PROGRESS, current, total }); } catch (_) { /* channel closed */ }
        }
      },
    });
    self.postMessage({ type: FWR_DONE, summary });
  } catch (err) {
    self.postMessage({ type: FWR_ERROR, message: (err && err.message) || String(err) });
  }
});

// Ready handshake: lets the main thread know the worker has imported its
// modules and is ready to receive a generate message. The main thread waits
// for this before transferring the 94 MB forest buffer so a worker-import
// failure doesn't leave it without a path to load trees.
self.postMessage({ type: FWR_READY });

