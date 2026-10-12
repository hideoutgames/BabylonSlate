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

  it("captures blending, draw buffers, attachments and fragment program details at the first failing draw", () => {
    const fragment = { kind: "fragment" };
    class StatefulGl {
      private error = 0;
      getError(): number { const code = this.error; this.error = 0; return code; }
      drawElements(...args: [mode: number, count: number, type: number, offset: number]): void { void args; this.error = 0x0502; }
      BLEND = 0x0be2; DEPTH_TEST = 0x0b71; STENCIL_TEST = 0x0b90; DRAW_FRAMEBUFFER = 0x8ca9; DRAW_FRAMEBUFFER_BINDING = 0x8ca6;
      MAX_COLOR_ATTACHMENTS = 0x8cdf; COLOR_ATTACHMENT0 = 0x8ce0; FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE = 0x8cd0; TEXTURE = 0x1702;
      FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE = 0x8211; FLOAT = 0x1406; INT = 0x1404; UNSIGNED_INT = 0x1405; UNSIGNED_NORMALIZED = 0x8c17;
      SIGNED_NORMALIZED = 0x8f9c; FRAMEBUFFER_ATTACHMENT_RED_SIZE = 0x8212; FRAMEBUFFER_ATTACHMENT_GREEN_SIZE = 0x8213;
      FRAMEBUFFER_ATTACHMENT_BLUE_SIZE = 0x8214; FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE = 0x8215; CURRENT_PROGRAM = 0x8b8d;
      SHADER_TYPE = 0x8b4f; FRAGMENT_SHADER = 0x8b30;
      getSupportedExtensions(): string[] { return ["EXT_color_buffer_float"]; }
      isEnabled(capability: number): boolean { return capability === this.BLEND; }
      drawBuffers(buffers: number[]): void { void buffers; }
      getParameter(pname: number): unknown {
        if (pname === this.DRAW_FRAMEBUFFER_BINDING) return {};
        if (pname === this.MAX_COLOR_ATTACHMENTS) return 2;
        return pname === this.CURRENT_PROGRAM ? {} : null;
      }
      getFramebufferAttachmentParameter(_target: number, point: number, pname: number): number {
        if (point !== this.COLOR_ATTACHMENT0) return 0;
        if (pname === this.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return this.TEXTURE;
        return pname === this.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE ? this.FLOAT : 32;
      }
      getAttachedShaders(): unknown[] { return [fragment]; }
      getShaderParameter(): number { return this.FRAGMENT_SHADER; }
      getShaderSource(): string { return "#version 300 es\n#define PREPASS\n#define PREPASS_NORMAL_INDEX 1\nlayout(location = 0) out vec4 glFragData[2];\nvoid main() {}"; }
    }
    vi.stubGlobal("WebGL2RenderingContext", StatefulGl);
    const uninstall = installGlErrorTrace();
    const gl = new StatefulGl();
    gl.drawBuffers([0x8ce0, 0x8ce1]);
    gl.drawElements(4, 12, 0x1403, 0);
    uninstall();

    expect(formatGlErrorTrace().filter((line) => line.startsWith("  state:"))).toEqual([
      "  state: extensions: EXT_color_buffer_float yes · EXT_float_blend no · OES_draw_buffers_indexed no",
      "  state: blend on · depth test off · stencil test off · drawBuffers(C0,C1)",
      "  state: draw framebuffer attachments: 0:tex float 32/32/32/32",
      "  state: fragment outputs: layout(location = 0) out vec4 glFragData[2];",
      "  state: fragment defines (2): PREPASS, PREPASS_NORMAL_INDEX 1",
    ]);
  });
});
