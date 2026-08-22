import { mediaStore, mintOriginalKey } from '@thp/media';

/**
 * **Real audio, in the real bucket** — what the player suites listen to.
 *
 * The browser suites for Story 4 cannot be driven against a stub. A media element only reports a
 * duration, only advances `currentTime`, only honours `playbackRate` and only issues a range
 * request when it is decoding something that is actually audio, served by something that actually
 * supports ranges. Every one of those is the property under test, so the bytes have to be real and
 * the store has to be the MinIO container the rest of the suite already talks to.
 *
 * **A synthesised WAV rather than a fixture file**, for three reasons: nothing binary enters the
 * repository; the length is a parameter, so a suite that needs to seek to a minute in can have a
 * teaching a minute long; and 16-bit PCM is the one format every browser decodes without argument,
 * which keeps a failing player test a failure of the player rather than of a codec.
 *
 * It is deliberately quiet — a low-amplitude tone rather than silence. Silence lets a decoder skip
 * work; a tone makes the element do the thing a member's teaching would make it do.
 */

const SAMPLE_RATE = 44_100;
const BYTES_PER_SAMPLE = 2;

/**
 * Mono 16-bit PCM, `seconds` long. The 44-byte canonical WAV header, then the samples.
 *
 * Roughly 88 KB per second, so a two-minute teaching is about 10 MB — large enough that a browser
 * has not buffered the end of it by the time a test seeks there, and small enough to `PUT` over a
 * loopback connection without the suite noticing.
 */
export function wavBytes(seconds: number): Uint8Array<ArrayBuffer> {
  const samples = SAMPLE_RATE * seconds;
  const dataBytes = samples * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // A quiet 220 Hz tone. Audible work for the decoder, inaudible to anybody who runs the suite
  // with the volume up.
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE) * 1200);
    view.setInt16(44 + index * BYTES_PER_SAMPLE, value, true);
  }

  return new Uint8Array(buffer);
}

/** The media settings the harness provides, as the store's environment reads them. */
export interface MediaSettings {
  readonly MEDIA_ENDPOINT: string;
  readonly MEDIA_REGION: string;
  readonly MEDIA_BUCKET: string;
  readonly MEDIA_ACCESS_KEY_ID: string;
  readonly MEDIA_SECRET_ACCESS_KEY: string;
}

/**
 * Put `seconds` of audio in the bucket and answer with its key.
 *
 * The `PUT` goes through the same presigned grant the admin upload screen uses, so what these
 * suites listen to arrived the way a real teaching does — including being stored with the content
 * type the grant was signed for, which is what the browser reads to decide it can play it.
 *
 * The store reads its five values from the environment with no defaults, and the suite's bucket is
 * not the one `.env` names, so the test process is given the harness's configuration exactly as the
 * media package's own suite does.
 */
export async function uploadTestAudio(
  settings: MediaSettings,
  seconds: number,
): Promise<{ key: string; bytes: number }> {
  Object.assign(process.env, settings);

  const contentType = 'audio/wav';
  const key = mintOriginalKey(contentType);
  const body = wavBytes(seconds);

  const url = await mediaStore().presignPut({ key, contentType, expiresInSeconds: 3600 });
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
  if (!response.ok) {
    throw new Error(`could not upload the test audio: ${response.status}`);
  }

  return { key, bytes: body.byteLength };
}
