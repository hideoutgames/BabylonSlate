import { useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { ContextMenuOverlay } from "@babylonslate/editor-kit";
import * as appearanceHelpers from "./homepage-project-appearance";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Composer({
  mode = "create",
  onSubmit = vi.fn(),
  open = true,
  busy = false,
  onOpenChange = vi.fn(),
}: {
  mode?: "create" | "edit";
  onSubmit?: () => void;
  open?: boolean;
  busy?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [name, setName] = useState(mode === "edit" ? "Moon Garden" : "");
  const [appearance, setAppearance] = useState({ icon: "box", color: "coral" });
  const [templateId, setTemplateId] = useState("empty");
  const props = {
    mode,
    open,
    onOpenChange,
    busy,
    name,
    onNameChange: setName,
    nameIssue: name.trim() ? null : "Name required.",
    appearance,
    onAppearanceChange: setAppearance,
    templateId,
    onTemplateIdChange: setTemplateId,
    templates: [{ id: "island", name: "Island" }],
    hostPlatform: "web",
    pickFolder: false,
    onPickFolderChange: vi.fn(),
    width: 1920,
    height: 1080,
    onWidthChange: vi.fn(),
    onHeightChange: vi.fn(),
    blackBars: false,
    onBlackBarsChange: vi.fn(),
    onSubmit,
  } satisfies ComponentProps<typeof HomepageCreateDialog>;
  return <HomepageCreateDialog {...props} />;
}

describe("Project Composer", () => {
  it("fits the visible viewport during keyboard resizing without losing the draft", async () => {
    const viewport = Object.assign(new EventTarget(), {
      height: 844,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    render(<Composer />);
    const dialog = screen.getByTestId("create-project-dialog");
    const name = screen.getByTestId("create-project-name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Orbit" } });
    act(() => {
      viewport.height = 440;
      viewport.offsetTop = 12;
      viewport.dispatchEvent(new Event("resize"));
    });
    await waitFor(() =>
      expect(dialog.style.getPropertyValue("--homepage-visible-height")).toBe(
        "440px",
      ),
    );
    expect(dialog.style.getPropertyValue("--homepage-visible-top")).toBe(
      "12px",
    );
    expect(name.value).toBe("Orbit");
    // Pinch zoom must not squeeze the form into the magnified viewport.
    act(() => {
      viewport.scale = 2;
      viewport.height = 220;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--homepage-visible-height")).toBe(
      "440px",
    );
  });
  it.each(["(pointer: coarse)", "(any-pointer: coarse)"])(
    "focuses the popup on touch devices (%s) so opening it does not summon the keyboard",
    async (touchQuery) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === touchQuery,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }));
      render(<Composer />);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId("create-project-dialog"),
        ),
      );
      expect(document.activeElement).not.toBe(
        screen.getByTestId("create-project-name"),
      );
    },
  );

  it("restores focus to project actions after editing from its context menu", async () => {
    function ContextEdit() {
      const [menuOpen, setMenuOpen] = useState(false);
      const [editOpen, setEditOpen] = useState(false);
      return (
        <>
          <button
            data-testid="project-actions"
            onClick={() => setMenuOpen(true)}
          >
            Project Actions
          </button>
          <ContextMenuOverlay
            menu={
              menuOpen
                ? {
                    open: true,
                    x: 20,
                    y: 20,
                    items: [
                      {
                        id: "edit",
                        label: "Edit Project",
                        onSelect: () => setEditOpen(true),
                      },
                    ],
                  }
                : null
            }
            onClose={() => setMenuOpen(false)}
          />
          <Composer mode="edit" open={editOpen} onOpenChange={setEditOpen} />
        </>
      );
    }
    render(<ContextEdit />);
    const trigger = screen.getByTestId("project-actions");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("context-menu-item-edit"));
    const input = screen.getByTestId("homepage-rename-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("previews the entered project name and chosen badge without losing the template selection", () => {
    render(<Composer />);
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Moon Garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
    fireEvent.click(screen.getByRole("button", { name: "Cyan" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Template" }));
    fireEvent.click(screen.getByTestId("create-project-template:island"));

    const preview = screen.getByTestId("project-identity-preview");
    expect(within(preview).getByText("Moon Garden")).toBeTruthy();
    const badge = preview.querySelector("[data-project-icon]");
    expect(badge?.getAttribute("data-project-icon")).toBe("rocket");
    expect(badge?.getAttribute("data-color")).toBe("mint");
    fireEvent.click(screen.getByRole("button", { name: "Choose Template" }));
    expect(
      screen
        .getByTestId("create-project-template:island")
        .getAttribute("data-selected"),
    ).toBe("true");
  });

  it("edits a saved identity without offering to replace its template or project settings", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="edit" onSubmit={onSubmit} />);
    expect(screen.getByRole("heading", { name: "Edit Project" })).toBeTruthy();
    expect(
      (screen.getByTestId("homepage-rename-input") as HTMLInputElement).value,
    ).toBe("Moon Garden");
    expect(screen.queryByTestId("create-project-templates")).toBeNull();
    expect(screen.queryByTestId("create-project-width")).toBeNull();
    expect(screen.queryByTestId("create-project-choose-location")).toBeNull();
    fireEvent.change(screen.getByTestId("homepage-rename-input"), {
      target: { value: "" },
    });
    expect(
      (screen.getByTestId("homepage-rename-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("homepage-rename-input"), {
      target: { value: "Sun Garden" },
    });
    fireEvent.click(screen.getByTestId("homepage-rename-confirm"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("rejects unsupported image files and retains the chosen badge", async () => {
    render(<Composer />);
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Garden" },
    });
    fireEvent.change(screen.getByLabelText("Upload Picture"), {
      target: {
        files: [new File(["<svg />"], "icon.svg", { type: "image/svg+xml" })],
      },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /PNG, JPEG, or WebP/,
    );
    expect(
      screen.getByTestId("project-identity-preview").querySelector("img"),
    ).toBeNull();
  });

  it("discards a late picture import after closing and allows the reopened form to submit", async () => {
    let resolvePicture!: (value: string) => void;
    vi.spyOn(appearanceHelpers, "prepareProjectPicture").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePicture = resolve;
        }),
    );
    const view = render(<Composer />);
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Garden" },
    });
    fireEvent.change(screen.getByLabelText("Upload Picture"), {
      target: {
        files: [
          new File([new Uint8Array(1)], "badge.png", { type: "image/png" }),
        ],
      },
    });
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    view.rerender(<Composer open={false} />);
    view.rerender(<Composer />);
    await act(async () => {
      resolvePicture("data:image/webp;base64,AAAA");
    });
    expect(
      screen.getByTestId("project-identity-preview").querySelector("img"),
    ).toBeNull();
    expect(
      (screen.getByTestId("create-project-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps the chosen template fixed while project creation is in progress", () => {
    render(<Composer busy />);
    expect(
      screen.getByRole("button", { name: "Choose Template" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Choose Template" }));
    expect(screen.queryByTestId("create-project-templates")).toBeNull();
  });

  it("guards submission and Escape dismissal while an edit is saving", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(
      <Composer
        mode="edit"
        busy
        onSubmit={onSubmit}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.submit(screen.getByTestId("create-project-form"));
    fireEvent.keyDown(screen.getByTestId("homepage-rename-input"), {
      key: "Escape",
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    view.rerender(
      <Composer mode="edit" onSubmit={onSubmit} onOpenChange={onOpenChange} />,
    );
    fireEvent.submit(screen.getByTestId("create-project-form"));
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByTestId("homepage-rename-input"), {
      key: "Escape",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
