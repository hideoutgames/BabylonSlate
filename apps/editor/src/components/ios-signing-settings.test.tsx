import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IosSigningSettings } from "./ios-signing-settings";

function macApp() {
  (globalThis as { haptic?: unknown }).haptic = { gameShell: { platform: "darwin", arch: "arm64", runtime: vi.fn(), packageMac: vi.fn(), macIdentities: vi.fn(),
    androidSettings: vi.fn(), packageAndroid: vi.fn(), iosToolchain: vi.fn(), packageIos: vi.fn() } };
}

afterEach(() => {
  cleanup();
  delete (globalThis as { haptic?: unknown }).haptic;
});

describe("iOS signing settings", () => {
  it("say iOS games are packaged in the desktop app on a Mac anywhere else", () => {
    render(<IosSigningSettings settings={{ teamId: "" }} onChange={vi.fn()} />);
    expect(screen.getByTestId("ios-signing-unavailable").textContent).toBe("iOS games are packaged in the Haptic desktop app on a Mac.");
    expect(screen.queryByTestId("setting-ios-team")).toBeNull();
  });

  it("save a Team ID only once it has its ten letters and digits, in capitals", () => {
    macApp();
    const onChange = vi.fn();
    render(<IosSigningSettings settings={{ teamId: "" }} onChange={onChange} />);
    const field = screen.getByTestId("setting-ios-team") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "abcde-12" } });
    expect(field.value).toBe("ABCDE12");
    expect(screen.getByText("A Team ID has ten letters and digits.")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "abcde12345" } });
    expect(onChange).toHaveBeenLastCalledWith({ teamId: "ABCDE12345" });
    expect(screen.queryByText("A Team ID has ten letters and digits.")).toBeNull();
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ teamId: "" });
  });
});
