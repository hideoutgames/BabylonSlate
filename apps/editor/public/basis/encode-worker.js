/**
 * Classic Worker: Basis Universal KTX2 encode (engineplan §3.5).
 * Protocol:
 *   { type: "init" }
 *   { type: "encode", id, source, mime, settings }  // preferred — decode+clamp here
 *   { type: "encode", id, rgba, width, height, settings }  // Safari fallback
 *   { type: "recycle" }
 * Replies: loaded | encoded | error | decode_unavailable | recycled
 */
/* eslint-disable no-undef */
let moduleInstance = null;

function post(msg, transfer) {
  self.postMessage(msg, transfer);
}

function clampSize(width, height, maxDimension) {
  const longest = Math.max(width, height);
  if (!maxDimension || longest <= maxDimension) {
    return { width: width, height: height };
  }
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function decodeSourceInWorker(sourceBuffer, maxDimension, mime) {
  if (typeof createImageBitmap !== "function") {
    return Promise.reject(new Error("createImageBitmap unavailable in encode worker"));
  }
  if (typeof OffscreenCanvas === "undefined") {
    return Promise.reject(new Error("OffscreenCanvas unavailable in encode worker"));
  }
  const blob = new Blob([sourceBuffer], mime ? { type: mime } : undefined);
  return createImageBitmap(blob).then(function (bitmap) {
    const size = clampSize(bitmap.width, bitmap.height, maxDimension);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("2D context unavailable for texture encode");
    }
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const imageData = ctx.getImageData(0, 0, size.width, size.height);
    bitmap.close();
    return {
      rgba: new Uint8Array(imageData.data.buffer.slice(0)),
      width: size.width,
      height: size.height,
    };
  });
}

function encodeRgba(id, rgba, width, height, settings) {
  let encoder = null;
  try {
    encoder = new moduleInstance.BasisEncoder();
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(true);
    encoder.setUASTC(true);
    encoder.setMipGen(Boolean(settings && settings.generateMipmaps));
    if (typeof (settings && settings.quality) === "number" && encoder.setQualityLevel) {
      encoder.setPackUASTCFlags(Math.max(0, Math.min(3, settings.quality | 0)));
    }
    encoder.setPerceptual(true);
    if (encoder.setKTX2SRGBTransferFunc) {
      encoder.setKTX2SRGBTransferFunc(true);
    }
    const imgType =
      moduleInstance.ldr_image_type && moduleInstance.ldr_image_type.cRGBA32
        ? moduleInstance.ldr_image_type.cRGBA32.value
        : false;
    encoder.setSliceSourceImage(0, rgba, width | 0, height | 0, imgType);
    const out = new Uint8Array(Math.max(1024 * 1024 * 8, rgba.byteLength));
    const started = performance.now();
    const len = encoder.encode(out);
    const wallMs = performance.now() - started;
    if (!len) {
      post({ type: "error", id: id, error: "BasisEncoder.encode returned 0" });
      return;
    }
    const ktx2 = out.slice(0, len);
    post(
      {
        type: "encoded",
        id: id,
        wallMs: wallMs,
        ktx2: ktx2.buffer,
      },
      [ktx2.buffer],
    );
  } catch (err) {
    post({ type: "error", id: id, error: String(err) });
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
    const settings = msg.settings || {};
    if (msg.source) {
      decodeSourceInWorker(
        msg.source,
        settings.maxDimension || 2048,
        msg.mime,
      )
        .then(function (decoded) {
          encodeRgba(msg.id, decoded.rgba, decoded.width, decoded.height, settings);
        })
        .catch(function (err) {
          post({
            type: "decode_unavailable",
            id: msg.id,
            error: String(err && err.message ? err.message : err),
          });
        });
      return;
    }
    if (msg.rgba) {
      encodeRgba(
        msg.id,
        new Uint8Array(msg.rgba),
        msg.width,
        msg.height,
        settings,
      );
      return;
    }
    post({ type: "error", id: msg.id, error: "encode missing source or rgba" });
  }
};
