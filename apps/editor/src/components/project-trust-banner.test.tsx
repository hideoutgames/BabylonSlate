import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EngineSettings } from "@haptic/vfs";
import { ProjectTrustBanner } from "./project-trust-banner";

const KEY = JSON.stringify(["opfs:Game", "project-guid"]);

const harness = vi.hoisted(() => ({
  untrusted: ["Level Tools"] as string[],
  trusted: [] as string[],
  updates: [] as string[][],
  utilities: [] as string[],
  untrustedNodes: [] as { kind: string; title: string; assets: string[] }[],
  refusals: 0,
}));

/** One snapshot object per held-back list, as the service keeps its snapshot until it changes. */
const snapshots = new Map<string, object>();
function snapshotFor(untrusted: string[], untrustedNodes: { kind: string; title: string; assets: string[] }[], trustRefusals: number): object {
  const key = JSON.stringify([untrusted, untrustedNodes, trustRefusals]);
  if (!snapshots.has(key)) {
    snapshots.set(key, { entries: [], commands: [], assetTypes: [], diagnostics: [], trusted: false, untrusted, untrustedNodes, trustRefusals });
  }
  return snapshots.get(key)!;
}

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    projectGuid: "project-guid",
    projectDocument: { settings: { editorUtilityObjects: harness.utilities } },
    extensionService: {
      subscribe: () => () => {},
      getSnapshot: () => snapshotFor(harness.untrusted, harness.untrustedNodes, harness.refusals),
      projectTrustKey: (guid: string) => JSON.stringify(["opfs:Game", guid]),
      createdHere: () => false,
      forgetCreatedProject: () => {},
      revokeTrust: () => {},
      clearRevocation: () => {},
    },
  })),
);

vi.mock("../context/app-settings-context", async () => {
  const { defaultEngineSettings } = await import("@haptic/vfs");
  return {
    useAppSettings: () => ({
      settings: { ...defaultEngineSettings(), trustedProjects: harness.trusted },
      version: 1,
      hydrated: true,
      updateSettings: async (mutate: (settings: EngineSettings) => void) => {
        const next = { ...defaultEngineSettings(), trustedProjects: [...harness.trusted] };
        mutate(next);
        harness.updates.push(next.trustedProjects);
      },
      updateDebuggerDefaults: async () => {},
    }),
  };
});

afterEach(() => {
  cleanup();
  harness.untrusted = ["Level Tools"];
  harness.trusted = [];
  harness.updates = [];
  harness.utilities = [];
  harness.untrustedNodes = [];
  harness.refusals = 0;
});

it("names the held-back Project Extensions and trusts the project on this computer when asked", async () => {
  render(<ProjectTrustBanner />);
  expect(screen.getByTestId("project-trust-banner").textContent).toContain("Level Tools");
  fireEvent.click(screen.getByRole("button", { name: "Trust Project" }));
  await waitFor(() => expect(harness.updates).toEqual([[KEY]]));
});

it("goes away on Not Now without trusting anything", () => {
  render(<ProjectTrustBanner />);
  fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
  expect(screen.queryByTestId("project-trust-banner")).toBeNull();
  expect(harness.updates).toEqual([]);
});

it("stays hidden for a trusted project and when nothing is held back", () => {
  harness.trusted = [KEY];
  render(<ProjectTrustBanner />);
  expect(screen.queryByTestId("project-trust-banner")).toBeNull();
  cleanup();
  harness.trusted = [];
  harness.untrusted = [];
  render(<ProjectTrustBanner />);
  expect(screen.queryByTestId("project-trust-banner")).toBeNull();
});

it("asks for trust when only registered Editor Utilities are held back", () => {
  harness.untrusted = [];
  harness.utilities = ["assets/Tools.class.hasset"];
  render(<ProjectTrustBanner />);
  const banner = screen.getByTestId("project-trust-banner");
  expect(banner.textContent).toContain("Editor Utilities");
  expect(banner.textContent).not.toContain("Extensions (");
});

it("names the assets whose Execute JavaScript was refused, and shows again after Not Now when more are refused", () => {
  harness.untrusted = [];
  harness.untrustedNodes = [{ kind: "executeJavaScript", title: "Execute JavaScript", assets: ["Hero"] }];
  harness.refusals = 1;
  const { rerender } = render(<ProjectTrustBanner />);
  const banner = screen.getByTestId("project-trust-banner");
  expect(banner.textContent).toContain("Execute JavaScript (Hero)");
  expect(banner.textContent).not.toContain("Extensions (");
  fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
  expect(screen.queryByTestId("project-trust-banner")).toBeNull();
  harness.untrustedNodes = [{ kind: "executeJavaScript", title: "Execute JavaScript", assets: ["Hero", "Level 1"] }];
  harness.refusals = 2;
  rerender(<ProjectTrustBanner />);
  expect(screen.getByTestId("project-trust-banner").textContent).toContain("Execute JavaScript (Hero, Level 1)");
  // Refused again for the same asset after Not Now: it shows again.
  fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
  harness.refusals = 3;
  rerender(<ProjectTrustBanner />);
  expect(screen.getByTestId("project-trust-banner").textContent).toContain("Execute JavaScript (Hero, Level 1)");
});

it("names each kind of refused node by its title in one prompt, an Extension node as one", () => {
  harness.untrusted = [];
  harness.untrustedNodes = [
    { kind: "executeJavaScript", title: "Execute JavaScript", assets: ["Hero"] },
    { kind: "openUrl", title: "Open URL", assets: ["Menu"] },
    { kind: "extension", title: "Open URL", assets: ["Game"] },
  ];
  harness.refusals = 1;
  render(<ProjectTrustBanner />);
  expect(screen.getAllByTestId("project-trust-banner")).toHaveLength(1);
  expect(screen.getByTestId("project-trust-banner").textContent).toContain(
    "This project's Execute JavaScript (Hero), Open URL (Menu) and Extension node Open URL (Game) would run on this computer.");
});
