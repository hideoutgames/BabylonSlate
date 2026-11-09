import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyProject } from "@haptic/core";
import { ProjectExportSettings } from "./project-export-settings";

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock());

afterEach(() => cleanup());

function renderSettings(appId = "") {
  const projectDocument = createEmptyProject("Harbour Run");
  projectDocument.settings.appIdentity = { appId, displayName: "", buildNumber: 3 };
  const updateProjectSettings = vi.fn();
  render(<ProjectExportSettings projectDocument={projectDocument} updateProjectSettings={updateProjectSettings}
    exportProjectBusy={false} exportProjectError={null} exportNotice={null} handleExport={async () => {}} />);
  return updateProjectSettings;
}

describe("App Identity", () => {
  it("shows the placeholder App ID and saves an App ID only once it is valid", () => {
    const update = renderSettings();
    const appId = screen.getByTestId("setting-app-id") as HTMLInputElement;
    expect(appId.placeholder).toBe("com.example.harbourrun");

    fireEvent.change(appId, { target: { value: "com.my-studio" } });
    expect(screen.getByText(/Use two or more parts of letters and digits/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(appId, { target: { value: "com.studio.harbour" } });
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "", buildNumber: 3 } });
    expect(screen.queryByText(/Use two or more parts/)).toBeNull();
  });

  it("saves the display name as typed, with the project name as its placeholder", () => {
    const update = renderSettings("com.studio.harbour");
    const name = screen.getByTestId("setting-app-display-name") as HTMLInputElement;
    expect(name.placeholder).toBe("Harbour Run");
    fireEvent.change(name, { target: { value: "Harbour" } });
    expect(update).toHaveBeenLastCalledWith({ appIdentity: { appId: "com.studio.harbour", displayName: "Harbour", buildNumber: 3 } });
  });
});
