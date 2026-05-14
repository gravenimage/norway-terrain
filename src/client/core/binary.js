export function readMagic(view, offset, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

export function assertMagic(view, expected, offset = 0) {
  const actual = readMagic(view, offset, expected.length);
  if (actual !== expected) {
    throw new Error(`Expected binary magic ${expected}, got ${actual}`);
  }
}

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
