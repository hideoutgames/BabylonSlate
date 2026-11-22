import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { EngineSettings } from "@haptic/vfs";
import { useProjectTrust } from "./use-project-trust";

const KEY = JSON.stringify(["opfs:Game", "project-guid"]);

const harness = vi.hoisted(() => ({
  calls: [] as string[],
  /** The settings write in flight; the test decides when it lands. */
  release: null as (() => void) | null,
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    projectGuid: "project-guid",
    extensionService: {
      projectTrustKey: (guid: string) => JSON.stringify(["opfs:Game", guid]),
      createdHere: () => false,
      forgetCreatedProject: () => harness.calls.push("forgetCreatedProject"),
      revokeTrust: () => harness.calls.push("revokeTrust"),
      clearRevocation: () => harness.calls.push("clearRevocation"),
    },
  })),
);

vi.mock("../context/app-settings-context", async () => {
  const { defaultEngineSettings } = await import("@haptic/vfs");
  return {
    useAppSettings: () => ({
      settings: { ...defaultEngineSettings(), trustedProjects: [KEY] },
      version: 1,
      hydrated: true,
      updateSettings: (mutate: (settings: EngineSettings) => void) => new Promise<void>((resolve) => {
        harness.calls.push("write");
        mutate({ ...defaultEngineSettings() });
        harness.release = () => {
          harness.calls.push("written");
          resolve();
        };
      }),
      updateDebuggerDefaults: async () => {},
    }),
  };
});

afterEach(() => {
  cleanup();
  harness.calls = [];
  harness.release = null;
});

it("takes trust back before the settings write lands, so a Play started meanwhile is refused", async () => {
  const { result } = renderHook(() => useProjectTrust());
  let done!: Promise<void>;
  act(() => { done = result.current.setTrusted(false); });
  expect(harness.calls).toEqual(["forgetCreatedProject", "revokeTrust", "write"]);
  await act(async () => { harness.release!(); await done; });
  expect(harness.calls).not.toContain("clearRevocation");
});

it("lets a grant count only once the settings record it", async () => {
  const { result } = renderHook(() => useProjectTrust());
  let done!: Promise<void>;
  act(() => { done = result.current.setTrusted(true); });
  expect(harness.calls).toEqual(["write"]);
  await act(async () => { harness.release!(); await done; });
  expect(harness.calls).toEqual(["write", "written", "clearRevocation"]);
});
