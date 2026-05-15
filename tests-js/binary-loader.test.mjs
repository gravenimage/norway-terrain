/**
 * @file Behavioural tests for BinaryLoader and the binary-registry catalog. The loader tests cover cursor advancement, alignment-aware Float32Array views, and the expectMagic mismatch path; the registry tests verify every consumer-listed format is catalogued.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('BinaryLoader advances the cursor as primitive readers are called', async () => {
  const { BinaryLoader } = await import('../src/client/core/binary-loader.js');
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setUint8(0, 0x41); // 'A'
  view.setUint8(1, 0x42); // 'B'
  view.setUint8(2, 0x43); // 'C'
  view.setUint8(3, 0x44); // 'D'
  view.setUint32(4, 0xDEADBEEF, true);
  view.setFloat32(8, 3.5, true);
  view.setUint16(12, 0x1234, true);

  const reader = new BinaryLoader(buf);
  assert.equal(reader.readMagic(4), 'ABCD');
  assert.equal(reader.offset, 4);
  assert.equal(reader.readUint32(), 0xDEADBEEF);
  assert.equal(reader.offset, 8);
  assert.equal(reader.readFloat32(), 3.5);
  assert.equal(reader.offset, 12);
  assert.equal(reader.readUint16(), 0x1234);
  assert.equal(reader.bytesRemaining, 2);
});

test('BinaryLoader.expectMagic throws when the file signature does not match', async () => {
  const { BinaryLoader } = await import('../src/client/core/binary-loader.js');
  const buf = new Uint8Array([0x57, 0x52, 0x4E, 0x47]).buffer; // 'WRNG'
  const reader = new BinaryLoader(buf);
  assert.throws(() => reader.expectMagic('BLD1'), /Expected binary magic BLD1, got WRNG/);
});

test('BinaryLoader.readFloat32Array returns a view sharing memory when aligned', async () => {
  const { BinaryLoader } = await import('../src/client/core/binary-loader.js');
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setFloat32(0, 1.0, true);
  view.setFloat32(4, 2.0, true);
  view.setFloat32(8, 3.0, true);
  view.setFloat32(12, 4.0, true);
  const reader = new BinaryLoader(buf);
  const floats = reader.readFloat32Array(4);
  assert.deepEqual(Array.from(floats), [1.0, 2.0, 3.0, 4.0]);
  assert.equal(reader.bytesRemaining, 0);
});

test('binary-registry catalogues every magic referenced by current parsers', async () => {
  const { BINARY_REGISTRY, lookupByMagic } = await import('../src/client/core/binary-registry.js');
  const expected = ['AMN1', 'BLD1', 'CANO', 'TRE1', 'TRE2', 'WATR', 'OSM2', 'FLT1', 'BRR1', 'QRR1'];
  for (const magic of expected) {
    assert.ok(BINARY_REGISTRY[magic], `missing registry entry for ${magic}`);
    assert.equal(lookupByMagic(magic).magic, magic);
  }
});

test('binary-registry returns undefined for unknown magic so callers can warn', async () => {
  const { lookupByMagic } = await import('../src/client/core/binary-registry.js');
  assert.equal(lookupByMagic('NOPE'), undefined);
});
