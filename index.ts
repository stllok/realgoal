import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { makeRealgoalRuntime, type RealgoalRuntime } from "./src/bridge/pi-wrapper.ts"
import { registerRealgoalCommands, type RegisterCommandsOptions } from "./src/commands/register-commands.ts"
import { registerRealgoalHooks } from "./src/lifecycle/register-hooks.ts"
import { registerRealgoalTools, type RegisterToolsOptions } from "./src/tools/register-tools.ts"
import { registerRealgoalRenderers } from "./src/ui/presentation.ts"

export interface RealgoalExtensionOptions extends RegisterToolsOptions, RegisterCommandsOptions {
  readonly runtime?: RealgoalRuntime
}

export const createRealgoalExtension =
  (options: RealgoalExtensionOptions = {}) =>
  (pi: ExtensionAPI): RealgoalRuntime => {
    const runtime = options.runtime ?? makeRealgoalRuntime()
    registerRealgoalRenderers(pi)
    registerRealgoalTools(pi, runtime, options)
    registerRealgoalCommands(pi, runtime, options)
    registerRealgoalHooks(pi, runtime)
    return runtime
  }

export default function realgoalExtension(pi: ExtensionAPI): void {
  createRealgoalExtension()(pi)
}

export * from "./src/domain/errors.ts"
export * from "./src/domain/models.ts"
export * from "./src/domain/config.ts"
export * from "./src/domain/reducer.ts"
export * from "./src/services/path-safety.ts"
export * from "./src/services/persistence.ts"
export * from "./src/services/realtasks-adapter.ts"
export * from "./src/services/preview-service.ts"
export * from "./src/services/worker-service.ts"
export * from "./src/services/doctor-service.ts"
export * from "./src/services/controller-service.ts"
export * from "./src/ui/presentation.ts"
export * from "./src/bridge/pi-wrapper.ts"
