import { newAssetGuid } from "../guid";
import type { ImportOptions, ImportResult } from "./types";
import { baseName } from "./util";
import {
  AUDIO_AUTO_STREAM_MIN_BYTES,
  AUDIO_DEFAULT_SOURCE_CHUNK,
} from "../audio-payload";

export function mimeForAudioBytes(bytes: Uint8Array): string {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return "audio/ogg";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return "audio/mpeg";
  }
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0
  ) {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

/** Leading zero bytes an MP3 may carry before its first frame (some encoders pad the start). */
const MP3_MAX_LEADING_PADDING = 64 * 1024;

/** An MPEG audio frame header: 11 sync bits, then a layer other than the reserved 00. */
function isMpegFrameStart(bytes: Uint8Array, at: number): boolean {
  return at + 1 < bytes.length && bytes[at] === 0xff && (bytes[at + 1]! & 0xe0) === 0xe0 && (bytes[at + 1]! & 0x06) !== 0;
}

/** An MP3 whose first frame follows zero padding, which {@link mimeForAudioBytes} does not look past. */
function isPaddedMp3(bytes: Uint8Array): boolean {
  let at = 0;
  const end = Math.min(bytes.length, MP3_MAX_LEADING_PADDING);
  while (at < end && bytes[at] === 0) at += 1;
  return at > 0 && isMpegFrameStart(bytes, at);
}

export async function importAudio(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  // The bytes decide, as for an added clip; bytes that are none of the formats Audio plays are refused.
  const sniffed = mimeForAudioBytes(bytes);
  const mime = sniffed !== "application/octet-stream"
    ? sniffed
    : isPaddedMp3(bytes) ? "audio/mpeg" : null;
  if (!mime) {
    throw new Error("The file is not MP3, WAV or Ogg audio: its contents do not start with an audio signature.");
  }

  return [
    {
      type: "Audio",
      name: baseName(options.fileName),
      guid: newAssetGuid(),
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {
        playbackMode:
          bytes.byteLength >= AUDIO_AUTO_STREAM_MIN_BYTES
            ? "streamed"
            : "decoded",
        clips: [
          {
            chunkId: AUDIO_DEFAULT_SOURCE_CHUNK,
            name: baseName(options.fileName),
            weight: 1,
          },
        ],
      },
      chunks: [{ id: "source", kind: "audio", mime, data: bytes }],
    },
  ];
}
