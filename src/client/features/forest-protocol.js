/**
 * @file Shared constants for the forest generation Web Worker protocol.
 *
 * Both sides — features/forest.js (main thread) and workers/forest-worker.js —
 * import these names instead of using bare strings so a typo can't silently
 * break the protocol. The bin payload shape is documented here as the source
 * of truth; both sides MUST agree on these field names.
 *
 * Direction is encoded in the constant name:
 *   FWR_*  worker → main
 *   FWS_*  main → worker (send to worker)
 */

export const FWR_READY    = 'ready';     // worker → main: module loaded, ready for generate
export const FWR_BIN      = 'bin';       // worker → main: one bin's attribute buffers (transferred)
export const FWR_PROGRESS = 'progress';  // worker → main: { current, total } bin progress
export const FWR_DONE     = 'done';      // worker → main: { summary } final aggregate stats
export const FWR_ERROR    = 'error';     // worker → main: { message } generation failed

export const FWS_GENERATE = 'generate';  // main → worker: { forestBuffer, obstacles } (transferred)

/**
 * Field names on the FWR_BIN payload. The worker constructs five Float32Arrays
 * per bin and posts them as transferables; the main thread reads them to build
 * an InstancedBufferGeometry. Names mirror the THREE attribute names the
 * material shader expects.
 */
export const BIN_FIELDS = Object.freeze({
  cellCx: 'cellCx',
  cellCy: 'cellCy',
  radius: 'radius',
  maxH: 'maxH',
  instanceCount: 'instanceCount',
  seedCount: 'seedCount',
  iPos: 'iPos',
  iSize: 'iSize',
  iRot: 'iRot',
  iCanopyA: 'iCanopyA',
  iCanopyB: 'iCanopyB',
});
