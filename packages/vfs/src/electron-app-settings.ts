import {
  defaultEngineSettings,
  engineSettingsSchema,
  type AppSettingsStore,
  type AppSettingsMutation,
  type EngineSettings,
  runSerializedAppSettingsUpdate,
} from "./app-settings";
import type { ElectronUserDataBridge } from "./platform";

/**
 * Desktop app-settings backend over the Electron userData bridge, so Engine
 * Settings persist on desktop. Bridge failures keep settings in memory.
 */
export class ElectronAppSettingsStore implements AppSettingsStore {
  private readonly bridge: ElectronUserDataBridge;
  private memory: EngineSettings | null = null;

  constructor(bridge: ElectronUserDataBridge) {
    this.bridge = bridge;
  }

  async load(): Promise<EngineSettings> {
    try {
      const raw = await this.bridge.readSettings();
      if (raw) return engineSettingsSchema.parse(JSON.parse(raw));
    } catch {
      /* fall back to memory / defaults below */
    }
    return this.memory ?? defaultEngineSettings();
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    this.memory = parsed;
    try {
      await this.bridge.writeSettings(JSON.stringify(parsed));
    } catch {
      /* keep the in-memory copy for this session */
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
