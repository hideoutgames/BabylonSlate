/**
 * The App Icon in each package's own format, from PNGs the editor renders
 * once per export (`APP_ICON_SIZES`): an ICO in the Windows executable,
 * hicolor PNGs for a Linux desktop entry, an ICNS in a macOS app, and a PNG
 * favicon for the web page. Pure byte work: rendering the PNGs needs a canvas
 * and stays with the caller.
 */

/** PNG bytes of the App Icon by edge length in pixels. */
export type AppIconImages = ReadonlyMap<number, Uint8Array>;

/** Every edge length a package uses: Windows 16–256, Linux 16–512, macOS 16–1024, the web 256. */
export const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;

/** The web page's favicon (`<link rel="icon">`) and the desktop game window's icon. */
export const APP_ICON_FILE = "icon.png";
/** Edge length of `APP_ICON_FILE`. */
export const APP_ICON_FILE_SIZE = 256;

/** Edge lengths inside the Windows ICO: Explorer and the taskbar at every scale up to 256 px. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

/** Edge lengths installed as `/usr/share/icons/hicolor/<n>x<n>/apps/<name>.png`. */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;

/** ICNS element types holding PNG data, with their edge length in pixels (`@2x` types count device pixels). */
const ICNS_TYPES: readonly [string, number][] = [
  ["icp4", 16], ["ic11", 32], ["icp5", 32], ["ic12", 64], ["ic07", 128],
  ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024],
];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG for one edge length, checked to be a PNG of that size. */
export function appIconPng(images: AppIconImages, size: number): Uint8Array {
  const png = images.get(size);
  if (!png) throw new Error(`The App Icon has no ${size} × ${size} image.`);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => png[index] !== byte) ||
    view.getUint32(16) !== size || view.getUint32(20) !== size) {
    throw new Error(`The App Icon's ${size} × ${size} image is not a PNG of that size.`);
  }
  return png;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A Windows `.ico` of PNG images (Windows Vista and later read PNG entries at every size). */
export function encodeIco(images: AppIconImages): Uint8Array {
  const pngs = ICO_SIZES.map((size) => [size, appIconPng(images, size)] as const);
  const header = new Uint8Array(6 + 16 * pngs.length);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, pngs.length, true);
  let offset = header.byteLength;
  pngs.forEach(([size, png], index) => {
    const entry = 6 + 16 * index;
    // 0 means 256 in the one-byte width and height.
    header[entry] = size % 256;
    header[entry + 1] = size % 256;
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, png.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    offset += png.byteLength;
  });
  return concat([header, ...pngs.map(([, png]) => png)]);
}

/** A macOS `.icns` of PNG elements, 16 pt to 512 pt at 1x and 2x. */
export function encodeIcns(images: AppIconImages): Uint8Array {
  const ascii = new TextEncoder();
  const elements = ICNS_TYPES.map(([type, size]) => {
    const png = appIconPng(images, size);
    const head = new Uint8Array(8);
    head.set(ascii.encode(type));
    new DataView(head.buffer).setUint32(4, 8 + png.byteLength);
    return concat([head, png]);
  });
  const head = new Uint8Array(8);
  head.set(ascii.encode("icns"));
  new DataView(head.buffer).setUint32(4, 8 + elements.reduce((sum, element) => sum + element.byteLength, 0));
  return concat([head, ...elements]);
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

/**
 * The player page with the game's name in its `<title>` (browser tabs and
 * desktop game windows show it) and, with an App Icon, a link to
 * `APP_ICON_FILE` at the end of its `<head>`.
 */
export function brandPlayerIndexHtml(html: string, options: { title: string; icon: boolean }): string {
  const title = `<title>${escapeHtml(options.title.trim() || "Game")}</title>`;
  const branded = html.replace(/<title>[\s\S]*?<\/title>/i, () => title);
  return options.icon
    ? branded.replace(/<\/head>/i, () => `  <link rel="icon" type="image/png" href="./${APP_ICON_FILE}" />\n</head>`)
    : branded;
}
