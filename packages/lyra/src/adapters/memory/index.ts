/**
 * The in-memory adapter: a host for tests, a dev script, and anywhere a run does
 * not need to outlive the process.
 *
 * It fills four of the five slots (there is no shell yet): storage, secrets,
 * waking and ids. Everything here is deterministic, because a test that cannot
 * predict the record cannot compare it (docs/adapters.md, decision 12).
 */

export { counterIds } from "./ids.js";
export { memorySecrets, type MemorySecrets } from "./secrets.js";
export {
	memoryStorage,
	DEFAULT_MAX_LINE_BYTES,
	type MemoryStorage,
	type MemoryStorageOptions,
} from "./storage.js";
export { memoryWaking, type MemoryWaking, type ScheduledWake } from "./waking.js";
