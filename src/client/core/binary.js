/**
 * @file Owns small binary parsing helpers shared by client-side loaders. These helpers keep file-signature checks and typed-array assembly explicit at call sites.
 */

/**
 * Reads an ASCII magic string from a DataView so binary loaders can validate file identity before trusting offsets.
 */
export function readMagic(view, offset, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

/**
 * Fails fast when a binary payload is not the expected format, preserving each parser's offset assumptions.
 */
export function assertMagic(view, expected, offset = 0) {
  const actual = readMagic(view, offset, expected.length);
  if (actual !== expected) {
    throw new Error(`Expected binary magic ${expected}, got ${actual}`);
  }
}

/**
 * Collapses streamed Float32Array chunks into one contiguous buffer for APIs that need stable indexed access.
 */
export function concatFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
