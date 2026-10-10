import { afterEach, describe, expect, it, vi } from "vitest";
import { formatGlErrorTrace, glErrorTraceActive, glErrorTraceEntries, installGlErrorTrace } from "./gl-error-trace";

/** Minimal stand-in: drawElements raises INVALID_OPERATION once, other calls succeed. */
class FakeGl {
  private error = 0;
  getError(): number { const code = this.error; this.error = 0; return code; }
  isContextLost(): boolean { return false; }
  useProgram(program: unknown): void { void program; }
  drawElements(...args: [mode: number, count: number, type: number, offset: number]): void { void args; this.error = 0x0502; }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installGlErrorTrace", () => {
  it("records the failing call yet still reports its error to the engine's own getError", () => {
    vi.stubGlobal("WebGL2RenderingContext", FakeGl);
    const nativeDraw = FakeGl.prototype.drawElements;
    const uninstall = installGlErrorTrace();
    expect(glErrorTraceActive()).toBe(true);
    const gl = new FakeGl();
    gl.useProgram({});
    gl.drawElements(4, 36, 0x1403, 0);

    expect(gl.getError()).toBe(0x0502);
    expect(gl.getError()).toBe(0);
    const entry = glErrorTraceEntries().at(-1)!;
    expect(entry).toMatchObject({ call: "drawElements", code: 0x0502, args: "4, 36, 0x1403, 0", before: ["useProgram"] });
    expect(formatGlErrorTrace(1)[0]).toMatch(/drawElements\(4, 36, 0x1403, 0\) → 1282 INVALID_OPERATION$/);

    uninstall();
    expect(glErrorTraceActive()).toBe(false);
    expect(FakeGl.prototype.drawElements).toBe(nativeDraw);
  });
});
