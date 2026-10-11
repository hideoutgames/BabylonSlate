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
 * Settings persist on desktop. Settings whose write fails stay in memory for
 * this session.
 */
export class ElectronAppSettingsStore implements AppSettingsStore {
  private readonly bridge: ElectronUserDataBridge;
  /** The last save the bridge refused; newer than the stored file. */
  private unsaved: EngineSettings | null = null;

  constructor(bridge: ElectronUserDataBridge) {
    this.bridge = bridge;
  }

  async load(): Promise<EngineSettings> {
    if (this.unsaved) return this.unsaved;
    try {
      const raw = await this.bridge.readSettings();
      if (raw) return engineSettingsSchema.parse(JSON.parse(raw));
    } catch {
      /* fall back to defaults below */
    }
    return defaultEngineSettings();
  }

  async save(settings: EngineSettings): Promise<void> {
    const parsed = engineSettingsSchema.parse(settings);
    try {
      await this.bridge.writeSettings(JSON.stringify(parsed));
      this.unsaved = null;
    } catch {
      this.unsaved = parsed;
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
