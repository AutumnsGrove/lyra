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
	fakeModelServer,
	sseFor,
	type FakeModelFault,
	type FakeModelRequest,
	type FakeModelServer,
	type FakeModelServerOptions,
} from "./fake-model-server.js";
export {
	scriptedArguments,
	scriptedModel,
	type ScriptedFailure,
	type ScriptedModel,
	type ScriptedModelOptions,
	type ScriptedToolCall,
	type ScriptedTurn,
} from "./model.js";
export {
	decodeCassette,
	encodeCassette,
	recordingFetch,
	replayCassette,
	scanForSecrets,
	scrubExchange,
	type Cassette,
	type CassetteFetchInit,
	type CassetteReplay,
	type RecordedExchange,
	type RecordedRequest,
	type RecordedResponse,
	type RecordingFetch,
	type SecretHit,
} from "./cassette.js";
export {
	misbehavingModel,
	misbehavingScript,
	MISBEHAVING_KINDS,
	type MisbehavingKind,
	type MisbehavingModel,
	type MisbehavingScriptOptions,
	type MisbehavingTurn,
} from "./misbehaving-model.js";
export { failingStorage, type FailingStorage, type FailingStorageOptions } from "./storage.js";
export {
	crashingStorage,
	type CrashingStorage,
	type CrashingStorageOptions,
} from "./crashing-storage.js";
export {
	renderHandles,
	renderPage,
	timelineTestRecipe,
	type TimelineCommit,
	type TimelineLine,
	type TimelinePage,
	type TimelineProject,
	type TimelineState,
} from "./timeline-recipe.js";
export {
	createFinishTool,
	executionCounter,
	toolAsking,
	toolReturning,
	toolReturningError,
	toolTakingTime,
	toolThatThrows,
	type Executions,
	type ScriptedToolOptions,
} from "./tools.js";
