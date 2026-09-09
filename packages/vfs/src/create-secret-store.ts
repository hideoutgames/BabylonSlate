import { CapacitorSecretStore } from "./capacitor-secret-store";
import { ElectronSecretStore } from "./electron-secret-store";
import {
  getElectronAccountSecretsBridge,
  isElectronHost,
  isMobilePlatform,
} from "./platform";
import { UnavailableSecretStore, type SecretStore } from "./secret-store";

export function createSecretStore(): SecretStore {
  if (isMobilePlatform()) {
    return new CapacitorSecretStore();
  }
  if (isElectronHost()) {
    return new ElectronSecretStore();
  }
  return new UnavailableSecretStore();
}

/** Uses only the desktop account bridge's encrypted or session-memory store. */
export function createAccountSecretStore(): SecretStore {
  if (isElectronHost()) {
    return new ElectronSecretStore(getElectronAccountSecretsBridge());
  }
  return createSecretStore();
}
