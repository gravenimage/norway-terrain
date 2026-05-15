/**
 * @file Cursor-style binary reader that wraps a DataView. The class is intentionally small: it owns offset bookkeeping so individual parsers stop hand-rolling indexing arithmetic and one bug-fix (alignment, endianness) lives in one place. Existing parsers continue to use the lower-level helpers in core/binary.js until each one is migrated; the two layers coexist on purpose.
 */

import { readMagic } from './binary.js';

/**
 * Wraps an ArrayBuffer or DataView with an offset cursor and typed-array slicing helpers. Endianness defaults to little-endian to match every binary format catalogued in core/binary-registry.js.
 */
export class BinaryLoader {
  constructor(source, { littleEndian = true } = {}) {
    if (source instanceof DataView) {
      this.view = source;
    } else if (source instanceof ArrayBuffer) {
      this.view = new DataView(source);
    } else if (ArrayBuffer.isView(source)) {
      this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    } else {
      throw new TypeError('BinaryLoader requires an ArrayBuffer, DataView, or TypedArray');
    }
    this.littleEndian = littleEndian;
    this.offset = 0;
  }

  /**
   * Reads `length` ASCII bytes as a string and advances the cursor.
   */
  readMagic(length = 4) {
    const text = readMagic(this.view, this.offset, length);
    this.offset += length;
    return text;
  }

  /**
   * Asserts the next `expected.length` bytes equal `expected`, advancing the cursor on success. Throws on mismatch with both the expected and observed magic so failures pinpoint the upstream tool.
   */
  expectMagic(expected) {
    const actual = this.readMagic(expected.length);
    if (actual !== expected) {
      throw new Error(`Expected binary magic ${expected}, got ${actual}`);
    }
    return actual;
  }

  readUint8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint16() {
    const value = this.view.getUint16(this.offset, this.littleEndian);
    this.offset += 2;
    return value;
  }

  readUint32() {
    const value = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  readInt32() {
    const value = this.view.getInt32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  readFloat32() {
    const value = this.view.getFloat32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  /**
   * Returns a Float32Array view over the next `count` floats and advances the cursor by 4*count bytes. The returned array shares memory with the underlying buffer to avoid copying large geometry payloads.
   */
  readFloat32Array(count) {
    const start = this.view.byteOffset + this.offset;
    if (start % 4 === 0) {
      const arr = new Float32Array(this.view.buffer, start, count);
      this.offset += count * 4;
      return arr;
    }
    const arr = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      arr[i] = this.readFloat32();
    }
    return arr;
  }

  /**
   * Returns a Uint8Array view over the next `count` bytes and advances the cursor. Shares memory with the underlying buffer.
   */
  readUint8Array(count) {
    const arr = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, count);
    this.offset += count;
    return arr;
  }

  /**
   * Reports remaining bytes from the current cursor to the end of the view, useful for bounds-checks at the end of a parse.
   */
  get bytesRemaining() {
    return this.view.byteLength - this.offset;
  }
}
