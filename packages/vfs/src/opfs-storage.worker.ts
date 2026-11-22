import { createOpfsFileOps, navigatorOpfsRoot } from "./opfs-file-ops";
import { serveOpfsFileOps, type OpfsWorkerEndpoint } from "./opfs-worker-protocol";

// One operations instance for the realm: every adapter of the page shares its directory cache.
serveOpfsFileOps(self as unknown as OpfsWorkerEndpoint, createOpfsFileOps(navigatorOpfsRoot()));
