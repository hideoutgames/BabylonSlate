/** What Get Device Motion reports. Screen axes: x right, y up, z out of the screen. */
export interface DeviceMotionState {
  /** The device has sent a reading since motion input started. */
  available: boolean;
  /** -1 to 1 from the calibrated pose; tilting right and tilting the top away are positive. */
  tilt: { x: number; y: number };
  /** Metres per second squared, without gravity. */
  acceleration: { x: number; y: number; z: number };
  /** Degrees per second around each screen axis. */
  rotationRate: { x: number; y: number; z: number };
}

export function idleDeviceMotion(): DeviceMotionState {
  return { available: false, tilt: { x: 0, y: 0 }, acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { x: 0, y: 0, z: 0 } };
}
