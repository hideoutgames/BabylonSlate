import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { defaultEngineSettings, type AppSettingsStore, type EngineSettings } from "@babylonslate/vfs";
import { AppSettingsProvider, useDebugMode, useGraphicsErrorTrace } from "./app-settings-context";

afterEach(cleanup);

function storeWith(patch: Partial<EngineSettings>): AppSettingsStore {
  let settings = { ...defaultEngineSettings(), ...patch };
  return {
    load: async () => settings,
    save: async (next) => { settings = next; },
    update: async (mutate) => { mutate(settings); return settings; },
  };
}

function Flags() {
  return <span data-testid="flags">{`${useDebugMode()} ${useGraphicsErrorTrace()}`}</span>;
}

describe("Debug Mode selector hooks", () => {
  it("follow hydration for a component mounted together with the provider", async () => {
    render(
      <AppSettingsProvider store={storeWith({ debugMode: true, traceGraphicsErrors: true })}>
        <Flags />
      </AppSettingsProvider>,
    );
    expect(await screen.findByText("true true")).toBeTruthy();
  });
});
