import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@babylonslate/core";
import { FakeLockProvider } from "@babylonslate/source-control";
import { MemorySecretStore } from "@babylonslate/vfs";
import { SourceControlService } from "../services/source-control-service";
import { DocumentLockBanner } from "./document-lock-banner";

const enabled = {
  ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  enabled: true,
  repositoryUrl: "https://github.com/org/repo",
};

async function serviceWithTheirs(): Promise<SourceControlService> {
  const service = new SourceControlService();
  const fake = new FakeLockProvider({ selfName: "Ada" });
  fake.addTheirs("assets/hero.scene.babasset", "Bob", "2026-08-15T11:50:00Z");
  await service.configure({
    settings: enabled,
    projectGuid: "proj",
    platform: "electron",
    testMode: true,
    secretStore: new MemorySecretStore(),
    nativeHttp: null,
    fake,
  });
  await service.refresh();
  service.onOpenDocument("assets/hero.scene.babasset");
  return service;
}

describe("DocumentLockBanner", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the holder and Edit Anyway, then leaves the banner after confirm", async () => {
    const service = await serviceWithTheirs();
    const { rerender } = render(
      <DocumentLockBanner
        path="assets/hero.scene.babasset"
        sourceControl={service}
      />,
    );
    expect(screen.getByTestId("document-lock-banner").getAttribute("data-lock-banner")).toBe(
      "theirs",
    );
    expect(screen.getByText("Locked by Bob")).toBeTruthy();
    fireEvent.click(screen.getByTestId("document-lock-edit-anyway"));
    rerender(
      <DocumentLockBanner
        path="assets/hero.scene.babasset"
        sourceControl={service}
      />,
    );
    expect(screen.getByTestId("document-lock-edit-anyway")).toBeTruthy();
    expect(service.isDocumentReadOnly("assets/hero.scene.babasset")).toBe(false);
  });
});
