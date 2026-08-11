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
