export {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_BT_BUILTIN_CLASSES,
  ENGINE_COMPONENT_CLASS_IDS,
  isLockedEngineClassId,
  type EngineBaseClassId,
  type EngineComponentClassId,
} from "./ids";
export {
  ClassRegistry,
  MAX_CLASS_INHERITANCE_DEPTH,
  type ClassDef,
  type ClassKind,
  type ReparentResult,
  type VariableDef,
} from "./class-registry";
export {
  InterfaceRegistry,
  dispatchInterface,
  interfaceHandlerKey,
  type InterfaceDispatchTarget,
  type InterfaceHandler,
  type InterfaceMethodDef,
  type ScriptInterfaceDef,
} from "./interfaces";
export {
  Actor,
  ActorComponent,
  BObject,
  GameInstance,
  type GameInstanceHooks,
  type LifecycleHooks,
  type TickContext,
  type WorldLike,
} from "./objects";
export {
  TICK_PHASES,
  TickClock,
  type PhaseHook,
  type TickPhase,
  type TickSchedulerOptions,
} from "./tick";
export { World, type WorldOptions, type WorldInputProvider } from "./world";
export {
  createActorsFromSerializedScene,
  runtimeTransformFromSerialized,
  type SceneActorHooks,
} from "./instantiate-scene";
export {
  createWorldSnapshot,
  stringifyWorldSnapshot,
  type WorldSnapshot,
} from "./snapshot";
