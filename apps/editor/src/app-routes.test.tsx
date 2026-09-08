import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
}));

// Project I/O and the GPU editor are the two external sides of this route boundary.
vi.mock("./context/document-context", () => ({
  useDocuments: () => ({
    route: documentState.route,
    listedProjects: [],
    templates: [],
    needsReconnect: false,
    recoveryAvailable: false,
    createEmptyProject: async () => {},
    createFromTemplate: async () => {},
    openProject: async () => {},
    openListedProject: async () => {},
    renameListedProject: async () => {},
    updateListedProject: async () => {},
    removeListedProject: async () => {},
    reconnectProject: async () => {},
    keepRecovery: async () => {},
    dismissRecovery: async () => {},
    refreshTemplates: async () => {},
  }),
}));
vi.mock("./routes/editor-route", () => ({
  default: () => <main aria-label="Editor Workspace" />,
}));
vi.mock("./components/settings-modal", () => ({ SettingsModal: () => null }));

afterEach(() => {
  cleanup();
  documentState.route = "home";
  vi.unstubAllEnvs();
});

describe("application route lifetime", () => {
  it("removes the project browser and its open profile when entering the editor, and starts fresh on return", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    const ui = () => (
      <TooltipProvider>
        <AppRoutes />
      </TooltipProvider>
    );
    const view = render(ui());
    expect(await screen.findByTestId("create-project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("dialog", { name: "Profile" })).toBeTruthy();
    documentState.route = "editor";
    view.rerender(ui());
    expect(
      await screen.findByRole("main", { name: "Editor Workspace" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("homepage")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.querySelector("[data-slate-home-styles]")).toBeNull();
    });
    documentState.route = "home";
    view.rerender(ui());
    expect(await screen.findByTestId("create-project")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
