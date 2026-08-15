import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@babylonslate/core";
import { FakeLockProvider } from "@babylonslate/source-control";
import { MemorySecretStore } from "@babylonslate/vfs";
import { SourceControlService } from "../services/source-control-service";
import { LocksPanelContents } from "./locks-panel";

const enabled = {
  ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
  enabled: true,
  repositoryUrl: "https://github.com/org/repo",
};

async function serviceWithLocks(): Promise<SourceControlService> {
  const service = new SourceControlService();
  const fake = new FakeLockProvider({ selfName: "Ada" });
  fake.addTheirs("assets/theirs.babasset", "Bob");
  await service.configure({
    settings: enabled,
    projectGuid: "proj",
    platform: "electron",
    testMode: true,
    secretStore: new MemorySecretStore(),
    nativeHttp: null,
    fake,
  });
  await service.autoLock("assets/mine.babasset");
  await service.refresh();
  return service;
}

describe("LocksPanelContents", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists locks and confirms Release All My Locks", async () => {
    const service = await serviceWithLocks();
    const { rerender } = render(<LocksPanelContents sourceControl={service} />);
    expect(screen.getByTestId("locks-panel")).toBeTruthy();
    expect(screen.getByTestId("locks-release-all").textContent).toContain(
      "Release All My Locks",
    );
    expect(screen.getByTestId("locks-release-all").textContent).toContain("(1)");
    expect(screen.getByTestId("locks-row-assets/mine.babasset")).toBeTruthy();
    expect(screen.getByTestId("locks-row-assets/theirs.babasset")).toBeTruthy();
    fireEvent.click(screen.getByTestId("locks-release-all"));
    expect(screen.getByTestId("locks-release-all-confirm")).toBeTruthy();
    expect(screen.getByText("Unpushed work becomes editable by others.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("locks-release-all-confirm-action"));
    });
    rerender(<LocksPanelContents sourceControl={service} />);
    expect(service.heldCount).toBe(0);
  });
});
