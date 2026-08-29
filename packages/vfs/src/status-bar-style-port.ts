export type StatusBarGlyphStyle = "light" | "dark";

export interface StatusBarStylePort {
  setStyle(style: StatusBarGlyphStyle): Promise<void>;
}

export class UnavailableStatusBarStyle implements StatusBarStylePort {
  async setStyle(): Promise<void> {}
}
