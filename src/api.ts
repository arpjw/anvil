// Library entrypoint. Importing Anvil never starts the command-line interface.
export { runOrchestrator, runDryRun, type OrchestratorOptions } from './agents/orchestrator.js';
export { runHeadless, type HeadlessResult } from './execution/headless.js';
export { uiStream, type UIEvent } from './ui/stream.js';
export { ValidationEngine } from './services/validation/index.js';
export { AVAILABLE_MODELS, buildClient } from './setup/config.js';
export type { SessionResult } from './session/result.js';
