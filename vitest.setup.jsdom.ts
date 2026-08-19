/**
 * jsdom implements neither ResizeObserver nor DOMMatrix, both of which React
 * Flow touches on mount. Minimal stand-ins keep component tests possible;
 * layout-dependent behaviour is covered by Playwright instead.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (!("DOMMatrixReadOnly" in globalThis)) {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(readonly transform?: string) {}
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly =
    DOMMatrixReadOnlyStub;
}

/** Base UI / Radix may call getAnimations; jsdom does not implement it. */
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
if (typeof Document !== "undefined" && !Document.prototype.getAnimations) {
  Document.prototype.getAnimations = () => [];
}

/** jsdom has no Canvas2D; FontEditor and similar measure via getContext. */
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      font: "",
      measureText: () => ({ width: 8 }),
      fillRect() {},
      clearRect() {},
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData() {},
    } as unknown as CanvasRenderingContext2D;
  };
}
