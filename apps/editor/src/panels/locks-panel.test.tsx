import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { err } from "@haptic/core";
import { FakeLockProvider, tokenCredential } from "@haptic/source-control";
import { FakeGitHost } from "@haptic/source-control/fake-host";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { MANUAL_SOURCE_CONTROL, signedInHosts } from "../testing/source-control-hosts";
import { SourceControlService } from "../services/source-control-service";
import { LocksPanelContents } from "./locks-panel";

/** The panel as the dock mounts it: re-rendered whenever the service changes. */
function LiveLocks({ service }: { service: SourceControlService }) {
  const [, setTick] = useState(0);
  useEffect(() => service.subscribe(() => setTick((tick) => tick + 1)), [service]);
  return <LocksPanelContents sourceControl={service} />;
}

const enabled = MANUAL_SOURCE_CONTROL;

async function serviceWithLocks(): Promise<SourceControlService> {
  const service = new SourceControlService();
  const fake = new FakeLockProvider({ selfName: "Ada" });
  fake.addTheirs("assets/theirs.hasset", "Bob");
  await service.configure({
    settings: enabled,
    projectKey: "proj",
    platform: "electron",
    testMode: true,
    hosts: await signedInHosts(),
    fake,
  });
  await service.autoLock("assets/mine.hasset");
  await service.refresh();
  return service;
}

describe("LocksPanelContents", () => {
  it("requires confirmation before force unlocking another person's asset", async () => {
    const service = await serviceWithLocks();
    try {
      render(<LocksPanelContents sourceControl={service} />);
      fireEvent.click(screen.getByTestId("locks-force-unlock-assets/theirs.hasset"));
      expect(screen.getByTestId("locks-force-unlock-confirm")).toBeTruthy();
      expect(service.lockForPath("assets/theirs.hasset")).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByTestId("locks-force-unlock-confirm-action"));
      });
      expect(service.lockForPath("assets/theirs.hasset")).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
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
    expect(screen.getByTestId("locks-row-assets/mine.hasset")).toBeTruthy();
    expect(screen.getByTestId("locks-row-assets/theirs.hasset")).toBeTruthy();
    fireEvent.click(screen.getByTestId("locks-release-all"));
    expect(screen.getByTestId("locks-release-all-confirm")).toBeTruthy();
    expect(screen.getByText("Unpushed work becomes editable by others.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("locks-release-all-confirm-action"));
    });
    rerender(<LocksPanelContents sourceControl={service} />);
    expect(service.heldCount).toBe(0);
  });

  it("shows Pushed and Not Pushed on our locks and releases only the pushed ones", async () => {
    const host = new FakeGitHost();
    const storage = new MemoryStorageAdapter();
    await storage.openDocumentsProject("game");
    await storage.writeBinary("assets/mine.hasset", new Uint8Array([1, 2, 3]));
    await storage.writeBinary("assets/edited.hasset", new Uint8Array([4]));
    // `git hash-object` of the bytes 01 02 03.
    host.remoteBlobs.set("assets/mine.hasset", "aed2973e4b8a7ff1b30ff5c4751e5a2b38989e74");
    host.remoteBlobs.set("assets/edited.hasset", "aed2973e4b8a7ff1b30ff5c4751e5a2b38989e74");
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/theirs.hasset", "Bob");
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await storage.writeBinary("assets/unsaved.hasset", new Uint8Array([1, 2, 3]));
      host.remoteBlobs.set("assets/unsaved.hasset", "aed2973e4b8a7ff1b30ff5c4751e5a2b38989e74");
      await service.configure({
        settings: MANUAL_SOURCE_CONTROL, projectKey: "proj", platform: "electron", testMode: true,
        hosts: await signedInHosts(host.http), fake, storage, isPathDirty: (path) => path === "assets/unsaved.hasset",
      });
      await service.autoLock("assets/mine.hasset");
      await service.autoLock("assets/edited.hasset");
      await service.autoLock("assets/unsaved.hasset");
      await service.refresh();
      render(<LiveLocks service={service} />);
      // The unsaved document's file is pushed, but its lock stays, so it is not counted.
      await waitFor(() => expect(screen.getByTestId("locks-release-pushed").textContent).toBe("Release Pushed Locks (1)"));
      expect(screen.getByTestId("locks-pushed-assets/unsaved.hasset").textContent).toBe("Pushed");
      expect(screen.getByTestId("locks-pushed-assets/mine.hasset").textContent).toBe("Pushed");
      expect(screen.getByTestId("locks-pushed-assets/edited.hasset").textContent).toBe("Not Pushed");
      expect(screen.queryByTestId("locks-pushed-assets/theirs.hasset")).toBeNull();
      expect(screen.getByTestId("locks-release-all").textContent).toBe("Release All My Locks (3)");
      await act(async () => {
        fireEvent.click(screen.getByTestId("locks-release-pushed"));
      });
      await waitFor(() => expect(screen.queryByTestId("locks-row-assets/mine.hasset")).toBeNull());
      expect(fake.snapshot().map((lock) => lock.path).sort()).toEqual(["assets/edited.hasset", "assets/theirs.hasset", "assets/unsaved.hasset"]);
    } finally {
      service.dispose();
    }
  });

  it("offers no Release Pushed Locks on a host without an API Haptic uses", async () => {
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({
        settings: { ...MANUAL_SOURCE_CONTROL, repositoryUrl: "https://gitea.example.com/team/game.git" },
        projectKey: "proj", platform: "electron", testMode: true,
        hosts: await signedInHosts(null, tokenCredential("https://gitea.example.com", "t", "token")),
        fake: new FakeLockProvider(),
      });
      await service.autoLock("assets/mine.hasset");
      render(<LiveLocks service={service} />);
      expect(screen.getByTestId("locks-release-all").textContent).toBe("Release All My Locks (1)");
      expect(screen.queryByTestId("locks-release-pushed")).toBeNull();
      expect(screen.queryByTestId("locks-pushed-assets/mine.hasset")).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it("ages each lock on refresh even when the lock itself is unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    const fake = new FakeLockProvider();
    fake.addTheirs("assets/theirs.hasset", "Bob", "2026-08-15T12:00:00Z");
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({ settings: MANUAL_SOURCE_CONTROL, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedInHosts(), fake });
      await service.refresh();
      render(<LiveLocks service={service} />);
      expect(screen.getByTestId("locks-row-assets/theirs.hasset").textContent).toContain("Bob · Just Now");
      vi.setSystemTime(new Date("2026-08-15T12:05:00Z"));
      await act(() => service.refresh());
      expect(screen.getByTestId("locks-row-assets/theirs.hasset").textContent).toContain("Bob · 5 Min Ago");
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("says the host does not support file locking instead of showing a lock error", async () => {
    const fake = new FakeLockProvider();
    vi.spyOn(fake, "verify").mockResolvedValue(err({ kind: "unsupported", message: "Not Found", status: 404 }));
    const service = new SourceControlService();
    service.pausePolling();
    try {
      await service.configure({ settings: MANUAL_SOURCE_CONTROL, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedInHosts(), fake });
      await service.refresh();
      render(<LiveLocks service={service} />);
      expect(screen.getByTestId("locks-unsupported").textContent).toBe("This Host Does Not Support File Locking.");
      expect(screen.queryByText("Could Not Refresh Locks")).toBeNull();
      expect(screen.queryByTestId("locks-release-all")).toBeNull();
    } finally {
      service.dispose();
    }
  });
});
