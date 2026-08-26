/**
 * **Real images, in the real bucket** — what the artwork suites upload.
 *
 * A synthesised WebP rather than a fixture file, for the same three reasons the synthesised WAV
 * beside it gives: nothing binary enters the repository, the byte length is a parameter so a suite
 * that needs something over the 2 MB ceiling can have it, and the bytes are a real image of the
 * real content type, so a failing test is a failure of the upload path rather than of a decoder.
 *
 * **The pixels are not the point here.** Nothing in scope plan 1.2 or 1.3 decodes what is stored —
 * the API checks size and content type against the store's metadata and nothing more — so what
 * these produce is a valid container of a chosen length rather than a picture of anything. The
 * console's re-encode is what makes real pixels matter, and that is asserted in the browser, on
 * real canvas output.
 */

/** A four-byte big-endian write, for the RIFF container's two length fields. */
function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * A WebP of exactly `size` bytes: the RIFF header, a `VP8L` chunk header, and padding.
 *
 * `size` is the whole file, so a suite can ask for exactly the ceiling and exactly one byte over it
 * and get objects the store will report at those sizes.
 */
export function webpBytes(size: number): Uint8Array<ArrayBuffer> {
  const HEADER = 20;
  if (size < HEADER) throw new Error(`a WebP cannot be shorter than ${HEADER} bytes`);
  const bytes = new Uint8Array(new ArrayBuffer(size));
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  writeUint32LE(bytes, 4, size - 8); // everything after this field
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
  writeUint32LE(bytes, 16, size - HEADER);
  bytes.fill(0x2f, HEADER);
  return bytes;
}

/** The same, as a PNG — for the one assertion that the accepted list is more than WebP. */
export function pngBytes(size: number): Uint8Array<ArrayBuffer> {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (size < SIGNATURE.length) throw new Error('a PNG cannot be shorter than its signature');
  const bytes = new Uint8Array(new ArrayBuffer(size));
  bytes.set(SIGNATURE, 0);
  bytes.fill(0x2f, SIGNATURE.length);
  return bytes;
}
