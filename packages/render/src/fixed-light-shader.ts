import { checkedShader } from "./checked-shader";

/**
 * Seat guards for fixed-shape light seats (`SLATE_FIXED_LIGHT{X}`, see
 * `fixed-light-binding.ts`). A seat is active while its bound buffer's range
 * (`vLightDiffuse.a`, which Babylon writes on every bind) is not negative;
 * empty seats bind a null buffer with -1.
 *
 * `SLATE_FIXED_LIGHT_MULTIPLY` picks the guard at compile time: without it each
 * seat runs behind a uniform branch, with it every seat runs and its
 * contribution is multiplied by the active flag (the null buffers hold finite
 * light data so the skipped work stays finite). Seats without
 * `SLATE_FIXED_LIGHT{X}` compile Babylon's code unchanged.
 */
export function withFixedLightSeats(source: string, wgsl: boolean): string {
  const branch = "#if defined(SLATE_FIXED_LIGHT{X}) && !defined(SLATE_FIXED_LIGHT_MULTIPLY)";
  const active = "step(0.0,light{X}.vLightDiffuse.a)";
  return checkedShader(source, wgsl ? "fixed light seats WGSL" : "fixed light seats GLSL")
    .replace(/^#ifdef LIGHT\{X\}\n/, `#ifdef LIGHT{X}\n${branch}\nif (light{X}.vLightDiffuse.a>=0.0) {\n#endif\n`)
    .replace(/#endif\n$/, `${branch}\n}\n#endif\n#endif\n`)
    // Every contribution below is scaled by `shadow`; an inactive seat also leaves the light count alone.
    .replace(
      "aggShadow+=shadow;numLights+=1.0;",
      `#if defined(SLATE_FIXED_LIGHT{X}) && defined(SLATE_FIXED_LIGHT_MULTIPLY)
shadow*=${active};aggShadow+=shadow;numLights+=${active};
#else
aggShadow+=shadow;numLights+=1.0;
#endif`,
    ).value;
}
