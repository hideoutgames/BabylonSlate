import { getHostPlatform } from "./platform";

export interface PickedImportFile {
  name: string;
  bytes: Uint8Array;
}

export interface PickImportFilesOptions {
  multiple?: boolean;
  accept?: string;
}

/**
 * Host-agnostic import picker (engineplan P2 Content Browser).
 * UI must call this instead of Capacitor plugins or ad-hoc file inputs.
 *
 * - web / electron: hidden `<input type="file">`
 * - ios / android: Capacitor document picker when a host bridge is installed;
 *   otherwise the same DOM file input (WKWebView presents the system picker)
 */
export async function pickImportFiles(
  options: PickImportFilesOptions = {},
): Promise<PickedImportFile[]> {
  const platform = getHostPlatform();
  if (platform === "ios" || platform === "android") {
    const native = await tryNativeDocumentPicker(options);
    if (native) return native;
  }
  return pickImportFilesViaDom(options);
}

interface NativePickerBridge {
  pickImportFiles?(
    options: PickImportFilesOptions,
  ): Promise<Array<{ name: string; data: ArrayBuffer | Uint8Array }>>;
}

async function tryNativeDocumentPicker(
  options: PickImportFilesOptions,
): Promise<PickedImportFile[] | null> {
  const host = globalThis as {
    babylonslate?: { documentPicker?: NativePickerBridge };
  };
  const picker = host.babylonslate?.documentPicker;
  if (!picker?.pickImportFiles) return null;
  const files = await picker.pickImportFiles(options);
  return files.map((file) => ({
    name: file.name,
    bytes:
      file.data instanceof Uint8Array
        ? file.data
        : new Uint8Array(file.data),
  }));
}

function pickImportFilesViaDom(
  options: PickImportFilesOptions,
): Promise<PickedImportFile[]> {
  if (typeof document === "undefined") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple !== false;
    if (options.accept) input.accept = options.accept;
    input.style.display = "none";
    input.dataset.testid = "vfs-import-picker-input";

    const cleanup = () => {
      input.remove();
    };

    let settled = false;
    const finish = (picked: PickedImportFile[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(picked);
    };

    input.addEventListener("change", () => {
      void (async () => {
        const list = input.files;
        if (!list?.length) {
          finish([]);
          return;
        }
        const picked: PickedImportFile[] = [];
        for (const file of Array.from(list)) {
          picked.push({
            name: file.name,
            bytes: await readFileBytes(file),
          });
        }
        finish(picked);
      })();
    });

    input.addEventListener("cancel", () => {
      finish([]);
    });

    document.body.appendChild(input);
    input.click();
  });
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  // jsdom File stubs may only expose a raw buffer via the constructor bits.
  const anyFile = file as File & { _buffer?: Uint8Array; buffer?: ArrayBuffer };
  if (anyFile._buffer) return new Uint8Array(anyFile._buffer);
  if (anyFile.buffer) return new Uint8Array(anyFile.buffer);
  return new Uint8Array(await new Response(file).arrayBuffer());
}
