/** A RIFF WEBP holding one `fourcc` chunk: header fields only, enough for size sniffing. */
export function webpHeader(fourcc: "VP8 " | "VP8L" | "VP8X", width: number, height: number, animated = false): Uint8Array {
  const body = new Uint8Array(fourcc === "VP8L" ? 5 : 10);
  const view = new DataView(body.buffer);
  if (fourcc === "VP8L") {
    body[0] = 0x2f;
    view.setUint32(1, (width - 1) | ((height - 1) << 14), true);
  } else if (fourcc === "VP8X") {
    body[0] = animated ? 2 : 0;
    view.setUint16(4, width - 1, true);
    view.setUint16(7, height - 1, true);
  } else {
    body.set([0, 0, 0, 0x9d, 0x01, 0x2a]);
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
  }
  const padded = body.length + (body.length % 2);
  const bytes = new Uint8Array(20 + padded);
  const riff = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  riff.setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([...fourcc].map((char) => char.charCodeAt(0)), 12);
  riff.setUint32(16, body.length, true);
  bytes.set(body, 20);
  return bytes;
}

/** A GIF89a header with its logical screen size and no image data. */
export function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}
