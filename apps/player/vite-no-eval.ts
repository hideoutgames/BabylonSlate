import type { Plugin } from "vite";

/**
 * A call that evaluates text: `eval(` or the `Function` constructor (`new Function(`, or `Function(` as minifiers write
 * it), bare or read off the global object (`window.eval(`); a method of another object with the same name is not one.
 */
const EVALUATION = /(?:(?<![\w$.])|(?<=\b(?:window|globalThis|self)\.))(?:(?:new\s+)?Function|eval)\s*\(/g;

/** The module id as the report names it: its path from `node_modules/` or the repository's `packages/` and `apps/`. */
function shortId(id: string): string {
  return id.replace(/\\/g, "/").replace(/^\0/, "").replace(/^.*\/node_modules\//, "").replace(/^.*\/(packages|apps)\//, "$1/");
}

/** Every module of `bundle` whose code evaluates text, with how many times. */
export function evaluatingModules(bundle: Record<string, { type: string; modules?: Record<string, { code?: string | null }> }>): Map<string, number> {
  const found = new Map<string, number>();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const [id, module] of Object.entries(output.modules ?? {})) {
      const count = module.code?.match(EVALUATION)?.length ?? 0;
      if (count > 0) found.set(shortId(id), (found.get(shortId(id)) ?? 0) + count);
    }
  }
  return found;
}

/**
 * Fails the player build when a module it bundles evaluates text, unless `allowed` names it with the reason it never
 * runs in a game: exported games boot under `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-eval'`) and on JIT-less
 * WebKit. Compiled scripts come from the game's static scripts module, never from evaluated text.
 */
export function noEvaluationReport(allowed: Readonly<Record<string, string>>): { main: Plugin; worker: () => Plugin } {
  const check = (bundle: Parameters<typeof evaluatingModules>[0], fail: (message: string) => never) => {
    const offenders = [...evaluatingModules(bundle)].filter(([id]) => !Object.hasOwn(allowed, id));
    if (offenders.length > 0) {
      fail(`The player bundle evaluates text, which a game's Content Security Policy forbids: ${offenders.map(([id, count]) => `${id} (${count})`).join(", ")}. ` +
        "Load code as a module instead, or add the module to the allow list with the reason it never runs in a game.");
    }
  };
  return {
    main: { name: "no-evaluation", apply: "build", generateBundle(_options, bundle) { check(bundle as never, (message) => this.error(message)); } },
    worker: () => ({ name: "no-evaluation-worker", generateBundle(_options, bundle) { check(bundle as never, (message) => this.error(message)); } }),
  };
}
