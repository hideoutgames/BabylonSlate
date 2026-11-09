import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AndroidPackagingChange, AndroidPackagingStatus } from "@haptic/vfs";
import { AndroidPackagingSettings } from "./android-packaging-settings";

const FOUND = { javaHome: "/opt/android-studio/jbr", javaVersion: 21, sdk: "/home/me/Android/Sdk", problems: [] };

/** The desktop app: its main process answers each change with what it then keeps; secrets live in a map. */
function desktopApp(initial: Omit<AndroidPackagingStatus, "toolchain">, toolchain: AndroidPackagingStatus["toolchain"] = FOUND) {
  let settings = initial;
  const androidSettings = vi.fn(async (change: AndroidPackagingChange | null) => {
    if (change && "pick" in change) settings = { ...settings, [change.pick]: `/picked/${change.pick}` };
    if (change && "clear" in change) settings = { ...settings, [change.clear]: null };
    if (change && "alias" in change) settings = { ...settings, alias: change.alias };
    return { ...settings, toolchain };
  });
  const secrets = new Map<string, string>([["android-signing:key-password", "kept"]]);
  const secretsBridge = { get: vi.fn(async (key: string) => secrets.get(key) ?? null), set: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }), delete: vi.fn() };
  (globalThis as { haptic?: unknown }).haptic = {
    gameShell: { platform: "linux", arch: "x64", runtime: vi.fn(), macIdentities: vi.fn(), packageMac: vi.fn(), androidSettings, packageAndroid: vi.fn() },
    secrets: secretsBridge,
  };
  return { androidSettings, secrets };
}

afterEach(() => {
  cleanup();
  delete (globalThis as { haptic?: unknown }).haptic;
});

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;

describe("Android packaging settings", () => {
  it("say Android games are packaged in the desktop app anywhere else", () => {
    render(<AndroidPackagingSettings />);
    expect(screen.getByTestId("android-packaging-unavailable").textContent).toBe("Android games are packaged in the Haptic desktop app.");
    expect(screen.queryByTestId("setting-android-java")).toBeNull();
  });

  it("show the JDK and SDK found, and ask the main process to pick or find them again", async () => {
    const { androidSettings } = desktopApp({ java: null, sdk: "/custom/sdk", keystore: null, alias: "" });
    await act(async () => { render(<AndroidPackagingSettings />); });
    expect(androidSettings).toHaveBeenCalledExactlyOnceWith(null);
    expect(input("setting-android-java").value).toBe("");
    expect(input("setting-android-java").placeholder).toBe("/opt/android-studio/jbr");
    expect(input("setting-android-sdk").value).toBe("/custom/sdk");
    expect(screen.queryByTestId("setting-android-java-reset")).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId("setting-android-java-choose")); });
    expect(androidSettings).toHaveBeenLastCalledWith({ pick: "java" });
    expect(input("setting-android-java").value).toBe("/picked/java");
    await act(async () => { fireEvent.click(screen.getByTestId("setting-android-sdk-reset")); });
    expect(androidSettings).toHaveBeenLastCalledWith({ clear: "sdk" });
    expect(input("setting-android-sdk").value).toBe("");
  });

  it("sign with the debug key until a keystore is chosen, then save its alias and passwords", async () => {
    const { androidSettings, secrets } = desktopApp({ java: null, sdk: null, keystore: null, alias: "" });
    await act(async () => { render(<AndroidPackagingSettings />); });
    expect(input("setting-android-keystore").placeholder).toBe("Debug Key (Testing Only)");
    expect(input("setting-android-alias").disabled).toBe(true);
    expect(input("setting-android-store-password").disabled).toBe(true);

    await act(async () => { fireEvent.click(screen.getByTestId("setting-android-keystore-choose")); });
    expect(input("setting-android-keystore").value).toBe("/picked/keystore");
    fireEvent.change(input("setting-android-alias"), { target: { value: " upload " } });
    await act(async () => { fireEvent.blur(input("setting-android-alias")); });
    expect(androidSettings).toHaveBeenLastCalledWith({ alias: "upload" });

    // The key password was saved earlier; the keystore password is typed now and never shown again.
    expect(input("setting-android-key-password").placeholder).toBe("Saved");
    fireEvent.change(input("setting-android-store-password"), { target: { value: "store-secret" } });
    await act(async () => { fireEvent.blur(input("setting-android-store-password")); });
    expect(secrets.get("android-signing:store-password")).toBe("store-secret");
    expect(input("setting-android-store-password").value).toBe("");
    expect(input("setting-android-store-password").placeholder).toBe("Saved");

    await act(async () => { fireEvent.click(screen.getByTestId("setting-android-keystore-reset")); });
    expect(androidSettings).toHaveBeenLastCalledWith({ clear: "keystore" });
    expect(input("setting-android-alias").disabled).toBe(true);
  });

  it("say what is missing when the build tools are not found", async () => {
    desktopApp({ java: null, sdk: null, keystore: null, alias: "" }, { javaHome: null, javaVersion: null, sdk: null, problems: ["No JDK found.", "No Android SDK found."] });
    await act(async () => { render(<AndroidPackagingSettings />); });
    expect(screen.getByTestId("android-toolchain-problems").textContent).toBe("No JDK found. No Android SDK found.");
    expect(input("setting-android-java").placeholder).toBe("Not Found");
  });
});
