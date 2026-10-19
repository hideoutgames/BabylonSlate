import { checkedShader } from "./checked-shader";

/**
 * Seat guards for fixed-shape light seats (`SLATE_FIXED_LIGHT{X}`, see
 * `fixed-light-binding.ts`). A seat is active while its bound buffer's range
 * (`vLightDiffuse.a`, which Babylon writes on every bind) is not negative;
 * empty seats bind a null buffer with -1.
 *
 * The guard is a compile-time choice. By default every seat runs without a
 * branch and its contribution is multiplied by the active flag after all its
 * math: everything a seat adds is scaled by `shadow`, and the null buffers
 * hold black, finite light data, so an empty seat adds exactly zero.
 * `SLATE_FIXED_LIGHT_BRANCH` runs each seat behind a uniform branch instead.
 * Seats without `SLATE_FIXED_LIGHT{X}` compile Babylon's code unchanged.
 */
export function withFixedLightSeats(source: string, wgsl: boolean): string {
  const branch = "#if defined(SLATE_FIXED_LIGHT{X}) && defined(SLATE_FIXED_LIGHT_BRANCH)";
  const active = "step(0.0,light{X}.vLightDiffuse.a)";
  return checkedShader(source, wgsl ? "fixed light seats WGSL" : "fixed light seats GLSL")
    .replace(/^#ifdef LIGHT\{X\}\n/, `#ifdef LIGHT{X}\n${branch}\nif (light{X}.vLightDiffuse.a>=0.0) {\n#endif\n`)
    .replace(/#endif\n$/, `${branch}\n}\n#endif\n#endif\n`)
    // Every contribution below is scaled by `shadow`; an inactive seat also leaves the light count alone.
    .replace(
      "aggShadow+=shadow;numLights+=1.0;",
      `#if defined(SLATE_FIXED_LIGHT{X}) && !defined(SLATE_FIXED_LIGHT_BRANCH)
shadow*=${active};aggShadow+=shadow;numLights+=${active};
#else
aggShadow+=shadow;numLights+=1.0;
#endif`,
    ).value;
}
