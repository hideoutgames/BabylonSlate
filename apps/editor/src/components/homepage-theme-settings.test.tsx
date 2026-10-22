import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryAppSettingsStore } from "@babylonslate/vfs";
import { AppSettingsProvider } from "../context/app-settings-context";
import { ThemeSettingsFields } from "./homepage-theme-settings";

const picked = vi.hoisted(() => ({ files: [] as { name: string; bytes: Uint8Array }[] }));

vi.mock("@babylonslate/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/vfs")>()),
  pickImportFiles: vi.fn(async () => picked.files),
}));

afterEach(() => {
  cleanup();
  picked.files = [];
});

function renderThemeSettings(store = new MemoryAppSettingsStore()) {
  const view = render(
    <AppSettingsProvider store={store}>
      <ThemeSettingsFields />
    </AppSettingsProvider>,
  );
  return { view, store };
}

describe("ThemeSettingsFields", () => {
  it("shows a non-interactive preview and keeps Style collapsed until opened", async () => {
    const { view } = renderThemeSettings();
    const preview = view.getByTestId("application-theme-preview");
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.hasAttribute("inert")).toBe(true);
    expect(view.getByTestId("application-theme-select").textContent).toContain("Default");
    expect(view.queryByLabelText("Background")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Style" }));
    await waitFor(() => expect(view.getByLabelText("Background Hex")).toBeTruthy());
  });

  it("forks Default into a custom theme instead of editing it", async () => {
    const { view, store } = renderThemeSettings();
    await waitFor(() => expect(view.getByTestId("application-theme-import").hasAttribute("disabled")).toBe(false));
    expect(view.queryByTestId("application-theme-delete")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Style" }));
    fireEvent.change(view.getByLabelText("Background Hex"), { target: { value: "#102030" } });

    await waitFor(() => expect(view.getByTestId("application-theme-select").textContent).toContain("Default Copy"));
    const saved = await store.load();
    expect(saved.customEditorThemes).toEqual([
      { id: saved.editorTheme, name: "Default Copy", colors: { background: "#102030" } },
    ]);
    expect(view.getByTestId("application-theme-preview").style.getPropertyValue("--background")).toBe("#102030");
    expect(view.getByTestId("application-theme-delete")).toBeTruthy();
  });

  it("imports a theme file as a new selected custom theme", async () => {
    picked.files = [{
      name: "night.json",
      bytes: new TextEncoder().encode(JSON.stringify({ format: "haptic-editor-theme", version: 1, name: "Night", colors: { card: "#223344" } })),
    }];
    const { view, store } = renderThemeSettings();
    await waitFor(() => expect(view.getByTestId("application-theme-import").hasAttribute("disabled")).toBe(false));
    fireEvent.click(view.getByTestId("application-theme-import"));

    await waitFor(() => expect(view.getByTestId("application-theme-notice").textContent).toContain("Imported Night."));
    const saved = await store.load();
    expect(saved.customEditorThemes).toMatchObject([{ id: saved.editorTheme, name: "Night", colors: { card: "#223344" } }]);
  });

  it("reports a file that is not a theme without changing settings", async () => {
    picked.files = [{ name: "notes.json", bytes: new TextEncoder().encode("{}") }];
    const { view, store } = renderThemeSettings();
    await waitFor(() => expect(view.getByTestId("application-theme-import").hasAttribute("disabled")).toBe(false));
    fireEvent.click(view.getByTestId("application-theme-import"));

    await waitFor(() => expect(view.getByTestId("application-theme-notice").textContent).toContain("not a Haptic theme"));
    expect((await store.load()).customEditorThemes).toEqual([]);
  });
});
