import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionSecretsNotice } from "./session-secrets-notice";

function installSecrets(persistent: boolean | null): void {
  (globalThis as { haptic?: unknown }).haptic = {
    userData: { readSettings: async () => null, writeSettings: async () => {} },
    secrets: {
      get: async () => null, set: async () => {}, delete: async () => {},
      ...(persistent === null ? {} : { persistent: async () => persistent }),
    },
  };
}

afterEach(() => {
  cleanup();
  delete (globalThis as { haptic?: unknown }).haptic;
});

describe("SessionSecretsNotice", () => {
  it("says secrets last only until quit when the desktop app cannot store them securely", async () => {
    installSecrets(false);
    render(<SessionSecretsNotice />);
    expect((await screen.findByTestId("session-secrets-notice")).textContent).toContain("only until Haptic quits");
  });

  it("stays hidden with secure storage and on hosts without the desktop bridge", async () => {
    for (const persistent of [true, null]) {
      installSecrets(persistent);
      render(<SessionSecretsNotice />);
      await Promise.resolve();
      await Promise.resolve();
      expect(screen.queryByTestId("session-secrets-notice")).toBeNull();
      cleanup();
    }
    delete (globalThis as { haptic?: unknown }).haptic;
    render(<SessionSecretsNotice />);
    expect(screen.queryByTestId("session-secrets-notice")).toBeNull();
  });
});
