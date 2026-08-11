/**
 * Classic Worker: Basis Universal KTX2 encode (engineplan §3.5).
 * Protocol:
 *   { type: "init" }
 *   { type: "encode", id, rgba, width, height, settings }
 *   { type: "recycle" }
 * Replies: loaded | encoded | error | recycled
 */
/* eslint-disable no-undef */
let moduleInstance = null;

function post(msg, transfer) {
  self.postMessage(msg, transfer);
}

self.onmessage = function (event) {
  const msg = event.data || {};
  if (msg.type === "init") {
    if (moduleInstance) {
      post({ type: "loaded" });
      return;
    }
    try {
      importScripts("basis_encoder.js");
      if (typeof BASIS !== "function") {
        post({ type: "error", error: "BASIS factory missing after importScripts" });
        return;
      }
      const absMain = new URL("basis_encoder.js", self.location.href).href;
      BASIS({
        mainScriptUrlOrBlob: absMain,
        locateFile: function (file) {
          return new URL(file, self.location.href).href;
        },
      })
        .then(function (mod) {
          moduleInstance = mod;
          if (mod.initializeBasis) mod.initializeBasis();
          post({ type: "loaded" });
        })
        .catch(function (err) {
          post({ type: "error", error: String(err) });
        });
    } catch (err) {
      post({ type: "error", error: String(err) });
    }
    return;
  }

  if (msg.type === "recycle") {
    moduleInstance = null;
    post({ type: "recycled" });
    return;
  }

  if (msg.type === "encode") {
    if (!moduleInstance) {
      post({ type: "error", id: msg.id, error: "encode before init" });
      return;
    }
    let encoder = null;
    try {
      const settings = msg.settings || {};
      encoder = new moduleInstance.BasisEncoder();
      encoder.setCreateKTX2File(true);
      encoder.setKTX2UASTCSupercompression(true);
      encoder.setUASTC(true);
      encoder.setMipGen(Boolean(settings.generateMipmaps));
      if (typeof settings.quality === "number" && encoder.setQualityLevel) {
        // UASTC pack flags / quality scalar — quality 0-4 maps loosely.
        encoder.setPackUASTCFlags(Math.max(0, Math.min(3, settings.quality | 0)));
      }
      encoder.setPerceptual(true);
      if (encoder.setKTX2SRGBTransferFunc) {
        encoder.setKTX2SRGBTransferFunc(true);
      }
      const rgba = new Uint8Array(msg.rgba);
      // Older builds: 5th arg is isJpg boolean. Newer: ldr_image_type enum.
      const imgType =
        moduleInstance.ldr_image_type && moduleInstance.ldr_image_type.cRGBA32
          ? moduleInstance.ldr_image_type.cRGBA32.value
          : false;
      encoder.setSliceSourceImage(0, rgba, msg.width | 0, msg.height | 0, imgType);
      const out = new Uint8Array(Math.max(1024 * 1024 * 8, rgba.byteLength));
      const started = performance.now();
      const len = encoder.encode(out);
      const wallMs = performance.now() - started;
      if (!len) {
        post({ type: "error", id: msg.id, error: "BasisEncoder.encode returned 0" });
        return;
      }
      const ktx2 = out.slice(0, len);
      post(
        {
          type: "encoded",
          id: msg.id,
          wallMs: wallMs,
          ktx2: ktx2.buffer,
        },
        [ktx2.buffer],
      );
    } catch (err) {
      post({ type: "error", id: msg.id, error: String(err) });
    } finally {
      if (encoder) {
        try {
          encoder.delete();
        } catch (_) {
          /* ignore */
        }
      }
    }
  }
};
