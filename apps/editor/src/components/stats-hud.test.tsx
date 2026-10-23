import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { STAT_GROUPS } from "@haptic/debugger";
import type { RenderDiagnostics } from "@haptic/render";
import { mountPlayerHud } from "../../../player/src/hud";
import { StatsHud } from "./stats-hud";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const barCount = (container: HTMLElement) =>
  container.querySelector('[data-testid="stats-hud-graph"]')!.children.length;

describe("StatsHud", () => {
  it("samples the Unit graph only while it is visible", () => {
    const hud = (visible: boolean) => (
      <StatsHud fps={60} scriptMs={1} physicsMs={2} groups={["unit"]} visible={visible} />
    );
    const view = render(hud(false));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(barCount(view.container)).toBe(1);

    view.rerender(hud(true));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(barCount(view.container)).toBe(6);

    view.rerender(hud(false));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(barCount(view.container)).toBe(6);
  });

  it("shows the same rows as the exported player for the same stats", () => {
    const rendering = {
      cpuMs: 1.5, gpuMs: 2.25, gpuStatus: "available", width: 1280, height: 720, shadowDrawCalls: 6,
      readbackMs: 0.5, autoLod: { meshes: 10, reduced: 3 }, qualityLimits: ["shadows off"],
    };
    const stats = {
      fps: 60, scriptMs: 5, physicsMs: 4, publishMs: 0.5, phaseMs: [0.5, 0.25, 2, 1, 4, 0.75, 0.5], memoryBytes: 2048, geometryBytes: 600 * 1024 * 1024,
      draws: 450, meshCount: 12, textureCount: 4, bridgeMessagesPerSec: 42, liveActors: 300, snapshotCapacity: 512, ticks: 1200,
    };
    const hostMemory = { jsHeapBytes: 3 * 1024 * 1024, appAvailableBytes: 900 * 1024 * 1024 };
    const editor = render(
      <StatsHud {...stats} hostMemory={hostMemory} rendering={rendering as unknown as RenderDiagnostics} groups={STAT_GROUPS} />,
    );
    const element = document.createElement("div");
    const player = mountPlayerHud(element, { bundleDebugger: true });
    for (const group of STAT_GROUPS) player.applyCommand({ type: "setStat", name: group, enabled: true });
    player.setStats({ ...stats, ...hostMemory, rendering });

    const texts = (elements: Iterable<Element>) => Array.from(elements, (part) => part.textContent);
    const editorRows = Object.fromEntries([
      ["frame", texts(editor.getByTestId("stats-hud").children[0]!.children)],
      ...STAT_GROUPS.map((group) => {
        const row = editor.getByTestId(`stats-hud-group-${group}`);
        return [group, [row.children[0]!.textContent, ...texts(row.children[1]!.children)]];
      }),
    ]);
    const playerRows = Object.fromEntries([
      ["frame", texts(element.firstElementChild!.children[0]!.children)],
      ...STAT_GROUPS.map((group) => [group, texts(element.querySelector(`[data-stat="${group}"]`)!.children)]),
    ]);
    expect(editorRows).toEqual(playerRows);
    expect(editorRows.threads).toEqual(["Threads", "bridge 42/s", "actors 300/512", "ticks 1200"]);
    expect(editorRows.unit).toContain("actors 2.00 ms");
  });
});
