import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { DEFAULT_RENDER_HEIGHT, DEFAULT_RENDER_WIDTH } from "@babylonslate/core";
import type { ListedProject } from "../lib/listed-projects";
import { Homepage } from "./homepage";

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

afterEach(() => {
  cleanup();
  getHostPlatform.mockReturnValue("web");
});

const noop = async () => {};

function renderHomepage(
  overrides: Partial<ComponentProps<typeof Homepage>> = {},
) {
  return render(
    <TooltipProvider>
      <Homepage
        projects={[]}
        templates={[]}
        needsReconnect={false}
        recoveryAvailable={false}
        onCreateEmpty={noop}
        onCreateFromTemplate={noop}
        onOpenExternal={noop}
        onOpenProject={noop}
        onRenameProject={noop}
        onRemoveFromList={noop}
        onReconnect={noop}
        onRecover={noop}
        onDismissRecovery={() => {}}
        onSettingsChanged={noop}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

function listedProject(
  name: string,
  tier: ListedProject["tier"],
): ListedProject {
  return { id: `${tier}:${name}`, name, tier, label: name };
}

describe("Homepage branding", () => {
  it("shows the Slate icon mark and product name, not the wordmark", () => {
    renderHomepage();

    expect(screen.getByTestId("brand-icon")).toBeTruthy();
    expect(screen.queryByTestId("brand-logo")).toBeNull();
    expect(screen.getByRole("heading", { name: "BabylonSlate" })).toBeTruthy();
    expect(screen.getByTestId("engine-settings")).toBeTruthy();
  });

  it("offers a built-in 2D Create Project card next to Empty", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    expect(await screen.findByTestId("create-project-empty")).toBeTruthy();
    expect(screen.getByTestId("create-project-2d")).toBeTruthy();
    expect(screen.getByTestId("create-project-width")).toBeTruthy();
    expect(screen.getByTestId("create-project-height")).toBeTruthy();
    expect(screen.getByTestId("create-project-black-bars")).toBeTruthy();
  });
});

describe("Homepage Start gallery", () => {
  it("places Open Folder beside Create Project, not in the template gallery", () => {
    renderHomepage();

    expect(screen.getByTestId("homepage-start")).toBeTruthy();
    expect(screen.getByTestId("homepage-start-empty")).toBeTruthy();
    expect(screen.getByTestId("homepage-start-2d")).toBeTruthy();

    const create = screen.getByTestId("create-project");
    const open = screen.getByTestId("open-project");
    const actions = create.closest('[data-testid="homepage-start-actions"]');
    expect(actions).toBeTruthy();
    expect(actions?.contains(open)).toBe(true);
    expect(open.textContent).toMatch(/Open Folder/i);
    expect(open.closest('[data-testid="homepage-start-gallery"]')).toBeNull();
  });

  it("scrolls Start templates horizontally in a single row", () => {
    renderHomepage({
      templates: [
        { id: "arena", name: "Arena" },
        { id: "dungeon", name: "Dungeon" },
      ],
    });

    const gallery = screen.getByTestId("homepage-start-gallery");
    expect(gallery.querySelector('[data-testid="homepage-start-empty"]')).toBeTruthy();
    expect(gallery.querySelector('[data-testid="homepage-start-2d"]')).toBeTruthy();
    expect(
      gallery.querySelector('[data-testid="homepage-start-template-arena"]'),
    ).toBeTruthy();
    expect(gallery.className).toMatch(/overflow-x-auto/);
    expect(gallery.className).toMatch(/overscroll-x-contain/);
    expect(gallery.className).toMatch(/flex-nowrap/);
    expect(gallery.className).not.toMatch(/overflow-y-auto/);
    expect(gallery.className).not.toMatch(/flex-wrap/);
    expect(gallery.className).not.toMatch(/max-h-/);
  });

  it("gives Start template cards an image well", () => {
    renderHomepage();

    expect(
      screen
        .getByTestId("homepage-start-empty")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("homepage-start-2d")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
  });

  it("shows discovered templates in the Start gallery", () => {
    renderHomepage({ templates: [{ id: "arena", name: "Arena" }] });

    expect(screen.getByTestId("homepage-start-template-arena")).toBeTruthy();
    expect(
      screen
        .getByTestId("homepage-start-template-arena")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
  });

  it("opens Create Project with Empty selected from the Start gallery", async () => {
    renderHomepage();
    screen.getByTestId("homepage-start-empty").click();

    expect(await screen.findByTestId("create-project-dialog")).toBeTruthy();
    expect(
      screen.getByTestId("create-project-empty").getAttribute("data-selected"),
    ).toBe("true");
  });

  it("opens Create Project with 2D selected from the Start gallery", async () => {
    renderHomepage();
    screen.getByTestId("homepage-start-2d").click();

    expect(await screen.findByTestId("create-project-dialog")).toBeTruthy();
    expect(
      screen.getByTestId("create-project-2d").getAttribute("data-selected"),
    ).toBe("true");
  });

  it("opens Create Project with a discovered template selected from the Start gallery", async () => {
    renderHomepage({ templates: [{ id: "arena", name: "Arena" }] });
    screen.getByTestId("homepage-start-template-arena").click();

    expect(await screen.findByTestId("create-project-dialog")).toBeTruthy();
    expect(
      screen
        .getByTestId("create-project-template-arena")
        .getAttribute("data-selected"),
    ).toBe("true");
  });
});

describe("Homepage Create Project copy", () => {
  it("sells Empty and 2D on web instead of an unavailable templates folder", () => {
    renderHomepage();
    const description = screen.getByTestId("create-project-description");
    expect(description.textContent).toMatch(/Empty/);
    expect(description.textContent).toMatch(/2D/);
    expect(description.textContent).not.toMatch(/not available on web/i);
    expect(description.textContent).not.toMatch(/templates folder/i);
    expect(description.textContent).not.toMatch(/Engine Settings/);
    expect(screen.getByTestId("create-project")).toBeTruthy();
  });

  it("mentions Engine Settings templates only as an optional extra on native", () => {
    getHostPlatform.mockReturnValue("ios");
    renderHomepage();
    const description = screen.getByTestId("create-project-description");
    expect(description.textContent).toMatch(/Empty/);
    expect(description.textContent).toMatch(/2D/);
    expect(description.textContent).toMatch(/Engine Settings/);
    expect(description.textContent).toMatch(/optional/i);
    expect(description.textContent).not.toMatch(/not available on web/i);
  });
});

describe("Homepage recent project rows", () => {
  it("renders recent projects as card rows with image wells", () => {
    renderHomepage({
      projects: [listedProject("Game.babproject", "opfs")],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.querySelector('[data-testid="project-card-well"]')).toBeTruthy();
  });

  it("shows Created and Last opened dates on a recent row", () => {
    renderHomepage({
      projects: [
        {
          ...listedProject("Game.babproject", "opfs"),
          createdAt: "2026-03-15T12:00:00.000Z",
          lastOpenedAt: "2026-08-18T12:00:00.000Z",
        },
      ],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.textContent).toMatch(/Created/);
    expect(row.textContent).toMatch(/Last opened/);
    expect(row.textContent).toContain(
      new Date("2026-03-15T12:00:00.000Z").toLocaleDateString(),
    );
    expect(row.textContent).toContain(
      new Date("2026-08-18T12:00:00.000Z").toLocaleDateString(),
    );
    expect(row.textContent).not.toMatch(/2026-03-15T12:00:00/);
  });

  it("omits Created when createdAt is missing", () => {
    renderHomepage({
      projects: [
        {
          ...listedProject("Game.babproject", "opfs"),
          lastOpenedAt: "2026-08-18T12:00:00.000Z",
        },
      ],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.textContent).not.toMatch(/Created/);
    expect(row.textContent).toMatch(/Last opened/);
  });

  it("does not show storage API names when every listed project is the same tier", () => {
    renderHomepage({
      projects: [
        listedProject("Game.babproject", "opfs"),
        listedProject("Other.babproject", "opfs"),
      ],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.textContent).toMatch(/Game/);
    expect(row.textContent).not.toMatch(/opfs|idb|documents|external/i);
    expect(row.textContent).not.toMatch(/On this device/);
  });

  it("labels a picked folder without storage API names", () => {
    renderHomepage({
      projects: [
        listedProject("Game.babproject", "opfs"),
        listedProject("Studio.babproject", "external"),
      ],
    });
    const device = screen.getByTestId("open-listed-project-Game.babproject");
    const folder = screen.getByTestId("open-listed-project-Studio.babproject");
    expect(device.textContent).toMatch(/On this device/);
    expect(folder.textContent).toMatch(/Chosen folder/);
    expect(device.textContent).not.toMatch(/opfs|idb/i);
    expect(folder.textContent).not.toMatch(/external|idb/i);
  });

  it("hides Search Filter Sort when there are no recents", () => {
    renderHomepage();
    expect(screen.queryByTestId("homepage-project-search")).toBeNull();
    expect(screen.queryByTestId("homepage-project-filter")).toBeNull();
    expect(screen.queryByTestId("homepage-project-sort")).toBeNull();
    expect(screen.getByTestId("no-projects")).toBeTruthy();
  });

  it("searches, sorts, and vertically scrolls recents", () => {
    renderHomepage({
      projects: [
        {
          ...listedProject("Zebra.babproject", "opfs"),
          lastOpenedAt: "2026-08-18T12:00:00.000Z",
        },
        {
          ...listedProject("Alpha.babproject", "opfs"),
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(screen.getByTestId("homepage-project-search")).toBeTruthy();
    expect(screen.getByTestId("homepage-project-sort")).toBeTruthy();
    expect(screen.queryByTestId("homepage-project-filter")).toBeNull();
    expect(screen.getByTestId("project-list").className).toMatch(/overflow-y-auto/);
    expect(screen.getByTestId("project-list").className).toMatch(
      /overscroll-y-contain/,
    );
    expect(screen.getByTestId("project-list").className).toMatch(/touch-pan-y/);

    const list = screen.getByTestId("project-list");
    const names = () =>
      Array.from(
        list.querySelectorAll("[data-testid^='open-listed-project-']"),
      ).map((row) => row.getAttribute("data-testid"));
    expect(names()[0]).toBe("open-listed-project-Zebra.babproject");

    fireEvent.click(screen.getByTestId("homepage-project-sort"));
    fireEvent.click(screen.getByTestId("homepage-project-sort-name-asc"));
    expect(names()[0]).toBe("open-listed-project-Alpha.babproject");

    fireEvent.change(screen.getByTestId("homepage-project-search"), {
      target: { value: "zebra" },
    });
    expect(screen.queryByTestId("open-listed-project-Alpha.babproject")).toBeNull();
    expect(screen.getByTestId("open-listed-project-Zebra.babproject")).toBeTruthy();
  });

  it("filters mixed locations and shows No matching projects", () => {
    renderHomepage({
      projects: [
        listedProject("Game.babproject", "opfs"),
        listedProject("Studio.babproject", "external"),
      ],
    });

    const filter = screen.getByTestId("homepage-project-filter");
    expect(filter.textContent).toMatch(/^Filter/);
    fireEvent.click(filter);
    fireEvent.click(screen.getByTestId("homepage-project-filter-chosen-folder"));
    expect(screen.getByTestId("homepage-project-filter").textContent).toMatch(
      /Filter \(1\)/,
    );
    expect(screen.getByTestId("open-listed-project-Studio.babproject")).toBeTruthy();
    expect(screen.queryByTestId("open-listed-project-Game.babproject")).toBeNull();

    fireEvent.change(screen.getByTestId("homepage-project-search"), {
      target: { value: "does-not-exist" },
    });
    expect(screen.getByTestId("no-matching-projects")).toBeTruthy();
    expect(screen.getByTestId("homepage-project-search")).toBeTruthy();
  });

  it("renders recents as Cards, not full-width buttons", () => {
    renderHomepage({
      projects: [listedProject("Game.babproject", "opfs")],
    });
    const row = screen.getByTestId("open-listed-project-Game.babproject");
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("data-slot")).toBe("card");
  });

  it("opens a project from a row tap and not from the remove control", async () => {
    const onOpenProject = vi.fn(async () => {});
    renderHomepage({
      projects: [listedProject("Game.babproject", "opfs")],
      onOpenProject,
    });
    fireEvent.click(screen.getByTestId("open-listed-project-Game.babproject"));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            "remove-listed-project-Game.babproject",
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );

    onOpenProject.mockClear();
    fireEvent.click(screen.getByTestId("remove-listed-project-Game.babproject"));
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(await screen.findByTestId("homepage-remove-dialog")).toBeTruthy();
  });

  it("confirms Remove from list from the row X without deleting files", async () => {
    const onRemoveFromList = vi.fn(async () => {});
    renderHomepage({
      projects: [listedProject("Game.babproject", "opfs")],
      onRemoveFromList,
    });
    fireEvent.click(screen.getByTestId("remove-listed-project-Game.babproject"));
    const dialog = await screen.findByTestId("homepage-remove-dialog");
    expect(dialog.textContent).toMatch(/Remove from List/);
    expect(dialog.textContent).toMatch(/files stay|remain on disk|does not delete/i);
    expect(dialog.getAttribute("data-variant")).not.toBe("destructive");

    fireEvent.click(screen.getByTestId("homepage-remove-cancel"));
    expect(onRemoveFromList).not.toHaveBeenCalled();
    expect(screen.getByTestId("open-listed-project-Game.babproject")).toBeTruthy();

    fireEvent.click(screen.getByTestId("remove-listed-project-Game.babproject"));
    fireEvent.click(await screen.findByTestId("homepage-remove-confirm"));
    expect(onRemoveFromList).toHaveBeenCalledTimes(1);
  });

  it("opens the same remove confirm from the row context menu", async () => {
    const onRemoveFromList = vi.fn(async () => {});
    renderHomepage({
      projects: [listedProject("Game.babproject", "opfs")],
      onRemoveFromList,
    });
    fireEvent.contextMenu(
      screen.getByTestId("open-listed-project-Game.babproject"),
    );
    expect(await screen.findByTestId("homepage-project-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("homepage-project-remove"));
    expect(await screen.findByTestId("homepage-remove-dialog")).toBeTruthy();
    expect(onRemoveFromList).not.toHaveBeenCalled();
  });
});

describe("Homepage Create Project dialog", () => {
  it("shows Name required and disables Create when Name is empty", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const name = await screen.findByTestId("create-project-name");
    fireEvent.change(name, { target: { value: "" } });
    expect(screen.getByTestId("create-project-name-issue").textContent).toBe(
      "Name required.",
    );
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows Name already exists and disables Create on a listed name", async () => {
    renderHomepage({
      projects: [listedProject("MyGame.babproject", "opfs")],
    });
    screen.getByTestId("create-project").click();
    expect(
      (await screen.findByTestId("create-project-name-issue")).textContent,
    ).toBe("Name already exists.");
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("drops template copy, says On this device, and explains Black Bars", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const dialog = await screen.findByTestId("create-project-dialog");
    expect(dialog.textContent).not.toMatch(/or a template/i);
    expect(screen.getByTestId("create-project-location").textContent).toBe(
      "On this device.",
    );
    expect(dialog.textContent).not.toMatch(/opfs/i);
    expect(screen.queryByTestId("create-project-choose-location")).toBeNull();
    expect(dialog.textContent).toContain(
      `Play and export resolution (default ${DEFAULT_RENDER_WIDTH}×${DEFAULT_RENDER_HEIGHT}).`,
    );
    expect(dialog.textContent).not.toMatch(/letterboxes/i);
    expect(dialog.textContent).toContain(
      "Renders black bars to force desired resolution.",
    );
  });

  it("does not pass pickFolder when creating on web", async () => {
    const onCreateEmpty = vi.fn(async () => {});
    renderHomepage({ onCreateEmpty });
    screen.getByTestId("create-project").click();
    fireEvent.click(await screen.findByTestId("create-project-submit"));
    expect(onCreateEmpty).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ pickFolder: true }),
    );
  });

  it("pins Create footer outside the right-pane form scroll", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const dialog = await screen.findByTestId("create-project-dialog");
    expect(dialog.className).toMatch(/90dvh/);
    const details = screen.getByTestId("create-project-details");
    expect(details.className).toMatch(/overflow-x-hidden/);
    expect(details.className).toMatch(/min-w-0/);
    const form = screen.getByTestId("create-project-form");
    expect(form.className).toMatch(/overflow-x-hidden/);
    expect(form.className).toMatch(/overflow-y-auto/);
    const footer = screen.getByTestId("create-project-footer");
    expect(form.contains(footer)).toBe(false);
    expect(details.contains(footer)).toBe(true);
  });

  it("gives dialog template cards an image well", async () => {
    renderHomepage();
    screen.getByTestId("create-project").click();
    const empty = await screen.findByTestId("create-project-empty");
    expect(empty.querySelector('[data-testid="template-card-well"]')).toBeTruthy();
    expect(
      screen
        .getByTestId("create-project-2d")
        .querySelector('[data-testid="template-card-well"]'),
    ).toBeTruthy();
  });

  it("requires Choose Location on iPad and keeps App Documents as the default", async () => {
    const onCreateEmpty = vi.fn(async () => {});
    getHostPlatform.mockReturnValue("ios");
    renderHomepage({ onCreateEmpty });
    screen.getByTestId("create-project").click();

    expect(await screen.findByTestId("create-project-choose-location")).toBeTruthy();
    expect(screen.getByTestId("create-project-app-documents")).toBeTruthy();
    expect(screen.queryByTestId("create-project-choose-folder")).toBeNull();
    expect(screen.getByTestId("create-project-location").textContent).toMatch(
      /App Documents/,
    );
    expect(screen.getByTestId("create-project-dialog").textContent).not.toMatch(
      /opfs/i,
    );

    fireEvent.click(screen.getByTestId("create-project-choose-location"));
    expect(screen.getByTestId("create-project-location").textContent).toMatch(
      /Choose a folder/,
    );
    fireEvent.click(screen.getByTestId("create-project-submit"));
    expect(onCreateEmpty).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ pickFolder: true }),
    );
  });

  it("requires Choose Location on Electron with a Projects folder default", async () => {
    getHostPlatform.mockReturnValue("electron");
    renderHomepage();
    screen.getByTestId("create-project").click();

    expect(await screen.findByTestId("create-project-choose-location")).toBeTruthy();
    expect(screen.getByTestId("create-project-app-documents")).toBeTruthy();
    expect(screen.getByTestId("create-project-location").textContent).toMatch(
      /Projects folder/,
    );
    expect(screen.getByTestId("create-project-dialog").textContent).not.toMatch(
      /opfs/i,
    );

    fireEvent.click(screen.getByTestId("create-project-app-documents"));
    expect(screen.getByTestId("create-project-location").textContent).toMatch(
      /Projects folder/,
    );
  });
});
