import { afterEach, expect, it, vi } from "vitest";
import { NullEngine, type Effect } from "@babylonjs/core";
import { bridgeEngineEffects, EFFECT_BRIDGE_MS, releaseBridgedEffects } from "./effect-bridge";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const engine of engines.splice(0)) engine.dispose();
});

function compile(engine: NullEngine, defines = ""): Effect {
  return engine.createEffect(
    { vertexSource: "void main(){gl_Position=vec4(0.0);}", fragmentSource: "void main(){gl_FragColor=vec4(1.0);}" },
    { attributes: [], uniformsNames: [], samplers: [], defines, fallbacks: null, onCompiled: null, onError: null },
    engine,
  );
}

it("keeps a closed view's Effects for the next view's Materials, then releases those it does not draw", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const shared = compile(engine);
  const unused = compile(engine, "#define UNUSED");
  bridgeEngineEffects(engine);
  // The closing view's draw wrappers release their references.
  shared.dispose();
  unused.dispose();
  expect(shared.isDisposed).toBe(false);
  // The next view's Material finds the compiled Effect in the Engine's cache.
  expect(compile(engine)).toBe(shared);
  releaseBridgedEffects(engine);
  expect(shared.isDisposed).toBe(false);
  expect(unused.isDisposed).toBe(true);
  shared.dispose();
  expect(shared.isDisposed).toBe(true);
});

it("ends a bridge no view presents after its time bound, and a later bridge takes over an earlier one", () => {
  vi.useFakeTimers();
  const engine = new NullEngine();
  engines.push(engine);
  const effect = compile(engine);
  bridgeEngineEffects(engine);
  bridgeEngineEffects(engine);
  effect.dispose();
  // Held once, by the later bridge only.
  expect(effect._refCount).toBe(1);
  vi.advanceTimersByTime(EFFECT_BRIDGE_MS);
  expect(effect.isDisposed).toBe(true);
});
