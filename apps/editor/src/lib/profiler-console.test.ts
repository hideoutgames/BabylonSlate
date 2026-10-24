import { describe, expect, it, vi } from "vitest";
import type { RenderFrameReport } from "@haptic/render";
import { DiagnosticResultsStore, type DiagnosticSessionPorts } from "../services/diagnostic-results-store";
import { runProfilerConsoleCommand, withProfilerHelp } from "./profiler-console";

const options = { durationMs: 10_000, byteBudget: 16 << 20 };

function session(mode: DiagnosticSessionPorts["mode"] = "play") {
  const store = new DiagnosticResultsStore();
  const ports = {
    mode,
    startProfile: vi.fn(async () => {}),
    stopProfile: vi.fn(async () => null),
    captureFrame: vi.fn(async () => ({ version: 1, frame: { renderFrameId: 1 } }) as unknown as RenderFrameReport),
  };
  store.bindSession(ports);
  return { store, ports, run: (line: string) => runProfilerConsoleCommand(line, store, () => options) };
}

describe("Profiler console commands", () => {
  it("record, stop and capture through the Profiler, and leave every other line to the game", async () => {
    const { store, ports, run } = session();
    expect(await run("Profile Start")).toMatchObject({ success: true });
    expect(ports.startProfile).toHaveBeenCalledWith(options);
    expect(store.getSnapshot().active).toBe("profile");

    expect(await run("profile stop")).toMatchObject({ success: true });
    expect(ports.stopProfile).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ active: null, open: true, view: "summary" });

    expect(await run("capture frame")).toMatchObject({ success: true });
    expect(ports.captureFrame).toHaveBeenCalledOnce();
    expect(store.getSnapshot().view).toBe("frame");

    expect(await run("slomo 0.5")).toBeNull();
    expect(await run("profile")).toEqual({ success: false, output: "usage: profile <start|stop>" });
  });

  it("say why they cannot run", async () => {
    const { run } = session();
    expect(await run("profile stop")).toEqual({ success: false, output: "No performance recording is running." });
    expect(await run("profile start now")).toEqual({ success: false, output: "profile start takes no arguments" });
    expect(await session("simulate").run("profile start")).toEqual({
      success: false,
      output: "Use Play or Preview Build for recording and frame capture.",
    });
    expect(await runProfilerConsoleCommand("capture frame", null, () => options)).toMatchObject({ success: false });
  });

  it("join the game's help", async () => {
    const { run } = session();
    expect(await run("help profile stop")).toEqual({
      success: true,
      output: "profile stop — Stop the performance recording and show its Summary",
    });
    expect(await run("help slomo")).toBeNull();
    expect(withProfilerHelp("help", { success: true, output: "engine:\n  slomo — Set time dilation" }).output).toBe([
      "engine:",
      "  slomo — Set time dilation",
      "profiler:",
      "  capture frame — Capture the render stages of the next frame",
      "  profile start — Start a performance recording, like Record Performance",
      "  profile stop — Stop the performance recording and show its Summary",
    ].join("\n"));
    expect(withProfilerHelp("help slomo", { success: true, output: "slomo" }).output).toBe("slomo");
  });
});
