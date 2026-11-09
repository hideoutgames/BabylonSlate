import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MacSigningSettings } from "./mac-signing-settings";

const IDENTITY = "Developer ID Application: Studio (TEAM123456)";

function macBridge(identities: string[]) {
  (globalThis as { haptic?: unknown }).haptic = { gameShell: { platform: "darwin", arch: "arm64", runtime: vi.fn(), packageMac: vi.fn(), macIdentities: vi.fn(async () => identities) } };
}

afterEach(() => {
  cleanup();
  delete (globalThis as { haptic?: unknown }).haptic;
});

describe("macOS Signing settings", () => {
  it("say macOS games are signed in the desktop app on a Mac anywhere else", () => {
    render(<MacSigningSettings settings={{ identity: null, notaryProfile: "" }} onChange={vi.fn()} />);
    expect(screen.getByTestId("mac-signing-unavailable").textContent).toBe("macOS games are signed in the Haptic desktop app on a Mac.");
    expect(screen.queryByTestId("setting-mac-signing-identity")).toBeNull();
  });

  it("keep notarization off while signing ad-hoc, and keep profile names to what notarytool accepts", async () => {
    macBridge([IDENTITY]);
    const onChange = vi.fn();
    await act(async () => { render(<MacSigningSettings settings={{ identity: null, notaryProfile: "" }} onChange={onChange} />); });
    expect(screen.getByTestId("setting-mac-signing-identity").textContent).toContain("Ad-Hoc (Local Testing)");
    expect((screen.getByTestId("setting-mac-notary-profile") as HTMLInputElement).disabled).toBe(true);

    cleanup();
    await act(async () => { render(<MacSigningSettings settings={{ identity: IDENTITY, notaryProfile: "" }} onChange={onChange} />); });
    expect(screen.getByTestId("setting-mac-signing-identity").textContent).toContain("Studio (TEAM123456)");
    fireEvent.change(screen.getByTestId("setting-mac-notary-profile"), { target: { value: "my profile/1" } });
    expect(onChange).toHaveBeenLastCalledWith({ identity: IDENTITY, notaryProfile: "myprofile1" });
  });

  it("flag a saved identity that is no longer in the keychain", async () => {
    macBridge([]);
    await act(async () => { render(<MacSigningSettings settings={{ identity: IDENTITY, notaryProfile: "notary" }} onChange={vi.fn()} />); });
    expect(screen.getByTestId("mac-signing-missing").textContent).toBe("This identity is not in this Mac's keychain.");
  });
});
