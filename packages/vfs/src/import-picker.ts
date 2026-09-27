export interface PickedImportFile {
  name: string;
  bytes: Uint8Array;
}

export interface PickImportFilesOptions {
  multiple?: boolean;
  accept?: string;
  /** Select a directory tree, preserving paths relative to the chosen folder. */
  directory?: boolean;
  maxTotalBytes?: number;
}

/**
 * Host-agnostic import picker (engineplan P2 Content Browser).
 * UI must call this instead of Capacitor plugins or ad-hoc file inputs.
 *
 * Every host uses a hidden `<input type="file">`; on iOS, WKWebView presents
 * the system document picker for it.
 */
export function pickImportFiles(
  options: PickImportFilesOptions = {},
): Promise<PickedImportFile[]> {
  if (typeof document === "undefined") {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple !== false;
    if (options.directory) input.setAttribute("webkitdirectory", "");
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
        if (
          options.maxTotalBytes &&
          Array.from(list).reduce((sum, file) => sum + file.size, 0) >
            options.maxTotalBytes
        )
          throw new Error("Selected files exceed the import size limit.");
        const picked: PickedImportFile[] = [];
        for (const file of Array.from(list)) {
          picked.push({
            name: options.directory
              ? file.webkitRelativePath || file.name
              : file.name,
            bytes: await readFileBytes(file),
          });
        }
        finish(picked);
      })().catch((error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });

    input.addEventListener("cancel", () => {
      finish([]);
    });

    document.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      cleanup();
      reject(error);
    }
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
