import { parseMovementProperties } from "@haptic/core";
import { ParsedComponentProperties } from "./parsed-component-properties";

/**
 * Each Movement component's settings, shared by the motor and the physics
 * collider sync: one parse serves both until a setting is written. Entries are
 * weak per component, so worlds and runtimes never see each other's.
 */
export const parsedMovementProperties = new ParsedComponentProperties((variables) => parseMovementProperties(variables));
