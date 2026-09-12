declare module "assimpjs" {
  export default function assimp(options?: {
    wasmBinary?: Uint8Array;
    locateFile?: (path: string) => string;
  }): Promise<import("./assimp-types").AssimpModule>;
}

declare module "assimpjs/dist/assimpjs.wasm?url" {
  const url: string;
  export default url;
}
