/**
 * The testkit: what every later step's tests are written with.
 *
 * It is published as `./testkit` because Lattice and other projects use it too,
 * and it may import the core and the memory adapter and nothing else. No
 * production file in the core may import it, which `scripts/importcheck.mjs`
 * enforces.
 */

export { fakeClock, FAKE_CLOCK_START, type FakeClock } from "./clock.js";
export {
	scriptedModel,
	type ScriptedFailure,
	type ScriptedModel,
	type ScriptedModelOptions,
	type ScriptedToolCall,
	type ScriptedTurn,
} from "./model.js";
export { failingStorage, type FailingStorage, type FailingStorageOptions } from "./storage.js";
export {
	crashingStorage,
	type CrashingStorage,
	type CrashingStorageOptions,
} from "./crashing-storage.js";
export {
	createFinishTool,
	executionCounter,
	toolReturning,
	toolReturningError,
	toolTakingTime,
	toolThatThrows,
	type Executions,
	type ScriptedToolOptions,
} from "./tools.js";
