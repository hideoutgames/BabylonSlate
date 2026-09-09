import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { AppRoutes } from "./app-routes";

const documentState = vi.hoisted(() => ({
  route: "home" as "home" | "editor",
  recoveryAvailable: false,
  keepRecovery: vi.fn(async () => {}),
}));

// Project I/O and the GPU editor are the two external sides of this route boundary.
vi.mock("./context/document-context", () => ({
  useDocuments: () => ({
    route: documentState.route,
    listedProjects: [],
    homepageReady: true,
    templates: [],
    needsReconnect: false,
    recoveryAvailable: documentState.recoveryAvailable,
    createEmptyProject: async () => {},
    createFromTemplate: async () => {},
    openProject: async () => {},
    openListedProject: async () => {},
    renameListedProject: async () => {},
    updateListedProject: async () => {},
    removeListedProject: async () => {},
    reconnectProject: async () => {},
    keepRecovery: documentState.keepRecovery,
    dismissRecovery: async () => {},
    refreshTemplates: async () => {},
  }),
}));
vi.mock("./routes/editor-route", () => ({
  default: () => <main aria-label="Editor Workspace" />,
}));
vi.mock("./components/settings-modal", () => ({ SettingsModal: () => null }));

beforeEach(() => {
  vi.stubGlobal("__BABYLONSLATE_BUILD_LABEL__", "0.0.1 Development build");
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  documentState.route = "home";
  documentState.recoveryAvailable = false;
  documentState.keepRecovery.mockReset();
  vi.unstubAllEnvs();
});

describe("application route lifetime", () => {
  it("keeps homepage actions locked until recovery finishes", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    documentState.recoveryAvailable = true;
    let finishRecovery!: () => void;
    documentState.keepRecovery.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    render(
      <TooltipProvider>
        <AppRoutes />
      </TooltipProvider>,
    );
    const recover = await screen.findByRole("button", { name: "Recover" });
    await waitFor(
      () => expect(document.querySelector(".slate-loading")).toBeNull(),
      { timeout: 5000 },
    );
    fireEvent.click(recover);
    // Let a discarded recovery Promise unlock actions, if the route drops it.
    await act(async () => {});
    expect(screen.getByTestId("create-project")).toHaveProperty(
      "disabled",
      true,
    );
    expect(recover).toHaveProperty("disabled", true);
    await act(async () => finishRecovery());
    expect(screen.getByTestId("create-project")).toHaveProperty(
      "disabled",
      false,
    );
    expect(recover).toHaveProperty("disabled", false);
  });

  it("removes the project browser and its open profile when entering the editor, and starts fresh on return", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    const ui = () => (
      <TooltipProvider>
        <AppRoutes />
      </TooltipProvider>
    );
    const view = render(ui());
    expect(await screen.findByTestId("create-project")).toBeTruthy();
    await waitFor(
      () => expect(document.querySelector(".slate-loading")).toBeNull(),
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    documentState.route = "editor";
    view.rerender(ui());
    expect(
      await screen.findByRole("main", { name: "Editor Workspace" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("homepage")).toBeNull();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.querySelector("[data-slate-home-styles]")).toBeNull();
    });
    documentState.route = "home";
    view.rerender(ui());
    expect(await screen.findByTestId("create-project")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
