/**
 * DOM globals the Node test project lacks and every shipped host (browsers, WebViews, Electron) has: Babylon's
 * simulated pointer events construct a PointerEvent (`GizmoHost.forwardPointer`), and its OBJ/MTL file IO reads
 * through FileReader (`convertObjToGlb`). The Babylon test project loads this first (`setupFiles`).
 */
export function installNodeDomPolyfills(): void {
  if (typeof PointerEvent !== "function") {
    class PointerEventShim extends Event {
      pointerId: number;
      button: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.button = init.button ?? 0;
        this.pointerType = String(init.pointerType ?? "mouse");
      }
    }
    Object.defineProperty(globalThis, "PointerEvent", { configurable: true, writable: true, value: PointerEventShim });
  }
  if (typeof globalThis.FileReader === "undefined") {
    class FileReaderPolyfill {
      result: string | ArrayBuffer | null = null;
      error: Error | null = null;
      onload: ((ev: { target: FileReaderPolyfill }) => void) | null = null;
      onerror: ((ev: { target: FileReaderPolyfill }) => void) | null = null;
      onloadend: ((ev: { target: FileReaderPolyfill }) => void) | null = null;
      onprogress: ((ev: unknown) => void) | null = null;
      abort(): void {}
      readAsText(blob: Blob): void {
        this.settle(blob.text());
      }
      readAsArrayBuffer(blob: Blob): void {
        this.settle(blob.arrayBuffer());
      }
      private settle(read: Promise<string | ArrayBuffer>): void {
        void read.then(
          (result) => {
            this.result = result;
            const ev = { target: this };
            this.onload?.(ev);
            this.onloadend?.(ev);
          },
          (error: Error) => {
            this.error = error;
            const ev = { target: this };
            this.onerror?.(ev);
            this.onloadend?.(ev);
          },
        );
      }
    }
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: FileReaderPolyfill });
  }
}

installNodeDomPolyfills();
