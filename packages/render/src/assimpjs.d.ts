declare module "assimpjs" {
  export interface AssimpFile {
    GetPath(): string;
    GetContent(): Uint8Array;
    delete(): void;
  }
  export interface AssimpResult {
    IsSuccess(): boolean;
    GetErrorCode(): number;
    FileCount(): number;
    GetFile(index: number): AssimpFile;
    delete(): void;
  }
  export interface AssimpModule {
    ConvertFile(name: string, format: string, bytes: Uint8Array,
      exists: (name: string) => boolean, load: (name: string) => Uint8Array): AssimpResult;
  }
  export default function assimp(options?: {
    wasmBinary?: Uint8Array;
    locateFile?: (path: string) => string;
  }): Promise<AssimpModule>;
}

declare module "assimpjs/dist/assimpjs.wasm?url" {
  const url: string;
  export default url;
}
