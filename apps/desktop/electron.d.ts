declare module "electron" {
  export const app: {
    whenReady(): Promise<void>;
    getPath(name: string): string;
    on(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
  };

  export class BrowserWindow {
    constructor(options: Record<string, unknown>);
    loadFile(file: string): Promise<void>;
    loadURL(url: string): Promise<void>;
    webContents: { openDevTools(): void };
  }

  export const ipcMain: {
    handle(
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => unknown,
    ): void;
  };

  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
  };

  export const net: {
    fetch(
      url: string,
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ): Promise<{
      status: number;
      text(): Promise<string>;
    }>;
  };

  export const dialog: {
    showOpenDialog(
      options: Record<string, unknown>,
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
}
