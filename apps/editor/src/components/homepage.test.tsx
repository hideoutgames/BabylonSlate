import type { ComponentProps } from "react";
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
import type { ListedProject } from "../lib/listed-projects";
import { Homepage } from "./homepage";
import { AppSettingsProvider } from "../context/app-settings-context";
import { EditorThemeProvider } from "../context/theme-context";

const { getHostPlatform } = vi.hoisted(() => ({
  getHostPlatform: vi.fn(() => "web"),
}));

vi.mock("@babylonslate/vfs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/vfs")>();
  return { ...actual, getHostPlatform };
});

vi.mock("./settings-modal", () => ({
  SettingsModal: () => null,
}));

vi.mock("./homepage-empty-art", () => ({ HomepageEmptyArt: () => null }));

beforeEach(() => {
  localStorage.clear();
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
  getHostPlatform.mockReturnValue("web");
});

const noop = async () => {};

function renderHomepage(
  overrides: Partial<ComponentProps<typeof Homepage>> = {},
) {
  return render(
    <TooltipProvider>
      <AppSettingsProvider>
        <EditorThemeProvider>
          <Homepage
            projects={[]}
            templates={[]}
            needsReconnect={false}
            recoveryAvailable={false}
            onCreateEmpty={noop}
            onCreateFromTemplate={noop}
            onOpenExternal={noop}
            onOpenProject={noop}
            onUpdateProject={noop}
            onRemoveFromList={noop}
            onReconnect={noop}
            onRecover={noop}
            onDismissRecovery={() => {}}
            onSettingsChanged={noop}
            {...overrides}
          />
        </EditorThemeProvider>
      </AppSettingsProvider>
    </TooltipProvider>,
  );
}

function listedProject(
  name: string,
  tier: ListedProject["tier"],
): ListedProject {
  return { id: `${tier}:${name}`, name, tier, label: name };
}

function createDialog(id = "blank") {
  fireEvent.click(screen.getByTestId("create-project"));
  fireEvent.click(screen.getByTestId(`create-project-${id}`));
}

describe("Slate project browser", () => {
  it("offers Blank, Basic 3D and Basic 2D starting points", () => {
    renderHomepage();
    fireEvent.click(screen.getByTestId("create-project"));
    for (const id of ["blank", "empty", "2d"])
      expect(screen.getByTestId(`create-project-${id}`)).toBeTruthy();
    expect(screen.getByTestId("engine-settings")).toBeTruthy();
  });

  it("opens web folder or ZIP imports explicitly", async () => {
    const onOpenExternal = vi.fn(async () => {});
    renderHomepage({ onOpenExternal });
    fireEvent.click(screen.getByTestId("open-project"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Import ZIP" }));
    await waitFor(() => expect(onOpenExternal).toHaveBeenCalledWith("zip"));
  });

  it("locks actions while opening and exposes a recoverable failure", async () => {
    let rejectOpen!: (error: Error) => void;
    const onOpenProject = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectOpen = reject;
        }),
    );
    renderHomepage({
      projects: [listedProject("Game", "opfs")],
      onOpenProject,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Project Game" }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toMatch(/Opening Project/i);
    expect(screen.getByTestId("create-project")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("engine-settings")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByTestId("homepage-start-blank"));
    expect(screen.queryByTestId("create-project-dialog")).toBeNull();
    await act(async () => rejectOpen(new Error("Project unavailable")));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("homepage-error").textContent).toContain(
      "Project unavailable",
    );
    expect(screen.getByTestId("create-project")).toHaveProperty(
      "disabled",
      false,
    );
    createDialog();
    expect(screen.getByTestId("create-project-dialog")).toBeTruthy();
  });

  it.each(["blank", "empty", "2d"])(
    "creates a named %s project with the selected appearance",
    async (kind) => {
      const onCreateEmpty = vi.fn(async () => {});
      renderHomepage({ onCreateEmpty });
      createDialog(kind);
      fireEvent.change(screen.getByTestId("create-project-name"), {
        target: { value: "Orbit" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
      fireEvent.click(screen.getByTestId("create-project-submit"));
      await waitFor(() =>
        expect(onCreateEmpty).toHaveBeenCalledWith(
          "Orbit",
          expect.objectContaining({
            kind,
            appearance: expect.objectContaining({ icon: "rocket" }),
          }),
        ),
      );
    },
  );

  it("searches custom templates and creates from the selected one", async () => {
    const onCreateFromTemplate = vi.fn(async () => {});
    renderHomepage({
      templates: [{ id: "arena", name: "Arena" }],
      onCreateFromTemplate,
    });
    fireEvent.click(screen.getByTestId("create-project"));
    fireEvent.change(
      screen.getAllByTestId("homepage-template-search").at(-1)!,
      { target: { value: "Arena" } },
    );
    fireEvent.click(screen.getByTestId("create-project-template:arena"));
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "My Arena" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(onCreateFromTemplate).toHaveBeenCalledWith(
        "arena",
        "My Arena",
        expect.any(Object),
      ),
    );
  });

  it("rejects empty or duplicate project names", () => {
    renderHomepage({ projects: [listedProject("Orbit", "opfs")] });
    createDialog();
    expect(screen.getByTestId("create-project-submit")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Orbit" },
    });
    expect(screen.getByTestId("create-project-submit")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("create-project-name-issue").textContent).toMatch(
      /already exists/i,
    );
  });

  it("retains the draft when creation fails", async () => {
    renderHomepage({
      onCreateEmpty: vi.fn(async () => {
        throw new Error("Storage full");
      }),
    });
    createDialog();
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Orbit" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Storage full"),
    );
    expect(screen.getByTestId("create-project-name")).toHaveProperty(
      "value",
      "Orbit",
    );
  });

  it("explains browser storage without native location controls", () => {
    renderHomepage();
    createDialog();
    fireEvent.click(screen.getByText("Options"));
    const dialog = screen.getByTestId("create-project-dialog");
    expect(dialog.textContent).toMatch(/Stored in this browser/i);
    expect(dialog.textContent).toMatch(/backup/i);
    expect(screen.queryByTestId("create-project-choose-location")).toBeNull();
    expect(screen.queryByTestId("create-project-app-documents")).toBeNull();
  });

  it.each(["ios", "electron"])(
    "offers native folder choice on %s",
    async (platform) => {
      getHostPlatform.mockReturnValue(platform);
      const onCreateEmpty = vi.fn(async () => {});
      renderHomepage({ onCreateEmpty });
      createDialog();
      fireEvent.change(screen.getByTestId("create-project-name"), {
        target: { value: "Orbit" },
      });
      fireEvent.click(screen.getByText("Options"));
      fireEvent.click(screen.getByTestId("create-project-choose-location"));
      fireEvent.click(screen.getByTestId("create-project-submit"));
      await waitFor(() =>
        expect(onCreateEmpty).toHaveBeenCalledWith(
          "Orbit",
          expect.objectContaining({ pickFolder: true }),
        ),
      );
    },
  );

  it.each(["button", "keyboard", "context"])(
    "opens project actions using %s without launching",
    (method) => {
      const onOpenProject = vi.fn(async () => {});
      renderHomepage({
        projects: [listedProject("Game", "opfs")],
        onOpenProject,
      });
      const card = screen.getByTestId("open-listed-project-Game");
      if (method === "button")
        fireEvent.click(
          screen.getByRole("button", { name: "Project Actions for Game" }),
        );
      else if (method === "keyboard")
        fireEvent.keyDown(card, { key: "F10", shiftKey: true });
      else fireEvent.contextMenu(card, { clientX: 30, clientY: 30 });
      expect(screen.getByTestId("homepage-project-menu")).toBeTruthy();
      expect(onOpenProject).not.toHaveBeenCalled();
    },
  );

  it("edits identity without creating or opening a project", async () => {
    const onUpdateProject = vi.fn(async () => {});
    const onOpenProject = vi.fn(async () => {});
    renderHomepage({
      projects: [listedProject("Game", "opfs")],
      onUpdateProject,
      onOpenProject,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Project Actions for Game" }),
    );
    fireEvent.click(screen.getByTestId("homepage-project-rename"));
    expect(screen.queryByTestId("create-project-templates")).toBeNull();
    fireEvent.change(screen.getByTestId("homepage-rename-input"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByTestId("homepage-rename-confirm"));
    await waitFor(() =>
      expect(onUpdateProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Game" }),
        expect.objectContaining({ name: "Renamed" }),
      ),
    );
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it.each([
    ["web", "opfs", "Delete"],
    ["ios", "documents", "Remove"],
  ] as const)(
    "confirms %s project removal before changing storage",
    async (platform, tier, action) => {
      getHostPlatform.mockReturnValue(platform);
      const onRemoveFromList = vi.fn(async () => {});
      renderHomepage({
        projects: [listedProject("Game", tier)],
        onRemoveFromList,
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Project Actions for Game" }),
      );
      fireEvent.click(screen.getByTestId("homepage-project-remove"));
      expect(
        screen.getByTestId("homepage-remove-confirm").textContent,
      ).toContain(action);
      expect(onRemoveFromList).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("homepage-remove-confirm"));
      await waitFor(() => expect(onRemoveFromList).toHaveBeenCalledOnce());
    },
  );

  it("searches projects without changing the stored library", () => {
    renderHomepage({
      projects: [listedProject("Orbit", "opfs"), listedProject("Tide", "opfs")],
    });
    fireEvent.click(screen.getByRole("button", { name: "Search Projects" }));
    fireEvent.change(screen.getByTestId("homepage-project-search"), {
      target: { value: "Tide" },
    });
    expect(screen.queryByTestId("open-listed-project-Orbit")).toBeNull();
    expect(screen.getByTestId("open-listed-project-Tide")).toBeTruthy();
  });

  it("persists the menu theme in Engine Settings and updates editor chrome", async () => {
    renderHomepage();
    fireEvent.click(screen.getByRole("button", { name: "Dark Mode" }));
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
    expect(
      JSON.parse(localStorage.getItem("babylonslate:engine-settings")!)
        .appearance.theme,
    ).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Light Mode" }));
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(false),
    );
    expect(
      screen.getByTestId("homepage").getAttribute("data-slate-theme"),
    ).toBe("light");
  });
});
