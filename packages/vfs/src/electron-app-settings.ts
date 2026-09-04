import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type AppSettingsMutation,
  type EngineSettings,
  runSerializedAppSettingsUpdate,
} from "./app-settings";
import { getElectronUserDataBridge, type ElectronUserDataBridge } from "./platform";

/**
 * Desktop app-settings backend over the Electron userData bridge. The full
 * desktop host lands in P14; this store is the settings half of it, so
 * Engine Settings persist on desktop instead of silently living in memory.
 */
export class ElectronAppSettingsStore implements AppSettingsStore {
  private readonly bridge: ElectronUserDataBridge | null;
  private memory: EngineSettings | null = null;

  constructor(bridge: ElectronUserDataBridge | null = getElectronUserDataBridge()) {
    this.bridge = bridge;
  }

  async load(): Promise<EngineSettings> {
    if (this.bridge) {
      try {
        const raw = await this.bridge.readSettings();
        if (raw) return engineSettingsSchema.parse(JSON.parse(raw));
      } catch {
        /* fall back to memory / defaults below */
      }
    }
    return this.memory ?? defaultEngineSettings();
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    this.memory = parsed;
    if (!this.bridge) return;
    try {
      await this.bridge.writeSettings(JSON.stringify(parsed));
    } catch {
      /* memory-only until the desktop host lands */
    }
  }

  update(mutate: AppSettingsMutation): Promise<EngineSettings> {
    return runSerializedAppSettingsUpdate(
      () => this.load(),
      (settings) => this.save(settings),
      mutate,
    );
  }
}
