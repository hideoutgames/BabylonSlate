import { StatusBar, Style } from "@capacitor/status-bar";
import type {
  StatusBarGlyphStyle,
  StatusBarStylePort,
} from "./status-bar-style-port";

export interface CapacitorStatusBarPlugin {
  setStyle(options: { style: Style }): Promise<void>;
}

const capacitorStatusBar: CapacitorStatusBarPlugin = StatusBar;

export class CapacitorStatusBarStyle implements StatusBarStylePort {
  private readonly plugin: CapacitorStatusBarPlugin;

  constructor(plugin: CapacitorStatusBarPlugin = capacitorStatusBar) {
    this.plugin = plugin;
  }

  async setStyle(style: StatusBarGlyphStyle): Promise<void> {
    await this.plugin.setStyle({
      style: style === "light" ? Style.Dark : Style.Light,
    });
  }
}
