/**
 * Node/Vitest Basis encode path using worker_threads + vendored wasm.
 * Browser editor uses createWorkerEncodeFn instead.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { EncodeFn } from "./encode-queue";
import type { TextureEncodeSettings } from "./texture-compression";

function basisDir(): string {
  // packages/assets/public/basis relative to this source file
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../public/basis");
}

/**
 * Encode solid-color / raw RGBA via Basis in a Node worker_threads Worker.
 * For CI A16 fixture smoke we synthesize RGBA rather than decoding PNG.
 */
export function createNodeBasisEncodeFn(
  makeRgba: (
    source: Uint8Array,
    settings: TextureEncodeSettings,
  ) => { rgba: Uint8Array; width: number; height: number },
): EncodeFn {
  const dir = basisDir();
  const encoderJs = join(dir, "basis_encoder.js");
  const wasmPath = join(dir, "basis_encoder.wasm");

  return async (source, settings) => {
    const { rgba, width, height } = makeRgba(source, settings);
    const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      globalThis.self = globalThis;
      eval(fs.readFileSync(workerData.encoderJs, 'utf8'));
      const wasmBinary = fs.readFileSync(workerData.wasm).buffer;
      BASIS({ wasmBinary }).then((Module) => {
        if (Module.initializeBasis) Module.initializeBasis();
        const e = new Module.BasisEncoder();
        e.setCreateKTX2File(true);
        e.setKTX2UASTCSupercompression(true);
        e.setUASTC(true);
        e.setMipGen(Boolean(workerData.generateMipmaps));
        e.setPerceptual(true);
        if (e.setKTX2SRGBTransferFunc) e.setKTX2SRGBTransferFunc(true);
        const rgba = new Uint8Array(workerData.rgba);
        e.setSliceSourceImage(0, rgba, workerData.width, workerData.height, false);
        const out = new Uint8Array(Math.max(8 * 1024 * 1024, rgba.byteLength));
        const t0 = performance.now();
        const len = e.encode(out);
        const wallMs = performance.now() - t0;
        try { e.delete(); } catch {}
        if (!len) {
          parentPort.postMessage({ ok: false, error: 'encode returned 0' });
          return;
        }
        const ktx2 = out.slice(0, len);
        parentPort.postMessage({ ok: true, wallMs, ktx2: ktx2.buffer }, [ktx2.buffer]);
      }).catch((err) => parentPort.postMessage({ ok: false, error: String(err) }));
    `;

    return await new Promise<{ ktx2: Uint8Array; wallMs: number }>(
      (resolve, reject) => {
        const worker = new Worker(code, {
          eval: true,
          workerData: {
            encoderJs,
            wasm: wasmPath,
            rgba: rgba.buffer.slice(
              rgba.byteOffset,
              rgba.byteOffset + rgba.byteLength,
            ),
            width,
            height,
            generateMipmaps: settings.generateMipmaps,
          },
        });
        worker.on("message", (msg: {
          ok: boolean;
          error?: string;
          wallMs?: number;
          ktx2?: ArrayBuffer;
        }) => {
          void worker.terminate();
          if (!msg.ok || !msg.ktx2) {
            reject(new Error(msg.error ?? "node basis encode failed"));
            return;
          }
          resolve({ ktx2: new Uint8Array(msg.ktx2), wallMs: msg.wallMs ?? 0 });
        });
        worker.on("error", (err) => {
          void worker.terminate();
          reject(err);
        });
      },
    );
  };
}

/** Deterministic checkerboard RGBA for CI encode smoke (ignores PNG bytes). */
export function syntheticRgbaForSize(size: number): {
  rgba: Uint8Array;
  width: number;
  height: number;
} {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = ((x >> 3) ^ (y >> 3)) & 1;
      rgba[i] = on ? 220 : 40;
      rgba[i + 1] = on ? 40 : 180;
      rgba[i + 2] = on ? 40 : 220;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width: size, height: size };
}

export function readVendoredBasisPresent(): boolean {
  try {
    readFileSync(join(basisDir(), "basis_encoder.wasm"));
    return true;
  } catch {
    return false;
  }
}
