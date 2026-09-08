import { useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import * as appearanceHelpers from "./homepage-project-appearance";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Composer({
  mode = "create",
  onSubmit = vi.fn(),
  open = true,
  busy = false,
}: {
  mode?: "create" | "edit";
  onSubmit?: () => void;
  open?: boolean;
  busy?: boolean;
}) {
  const [name, setName] = useState(mode === "edit" ? "Moon Garden" : "");
  const [appearance, setAppearance] = useState({ icon: "box", color: "coral" });
  const [templateId, setTemplateId] = useState("empty");
  const props = {
    mode,
    open,
    onOpenChange: vi.fn(),
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
  it("previews the entered project name and chosen badge without losing the template selection", () => {
    render(<Composer />);
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Moon Garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
    fireEvent.click(screen.getByRole("button", { name: "Mint" }));
    fireEvent.click(screen.getByTestId("create-project-template-island"));

    const preview = screen.getByTestId("project-identity-preview");
    expect(within(preview).getByText("Moon Garden")).toBeTruthy();
    const badge = preview.querySelector("[data-project-icon]");
    expect(badge?.getAttribute("data-project-icon")).toBe("rocket");
    expect(badge?.getAttribute("data-color")).toBe("mint");
    expect(
      screen
        .getByTestId("create-project-template-island")
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
    const alternative = screen.getByTestId("create-project-template-island");
    fireEvent.click(alternative);
    fireEvent.keyDown(alternative, { key: "Enter" });
    expect(
      screen.getByTestId("create-project-empty").getAttribute("data-selected"),
    ).toBe("true");
  });
});
