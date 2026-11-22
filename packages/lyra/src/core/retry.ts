/**
 * The waits between tries (decision 26).
 *
 * Three retries with growing delays, and a healthy run never waits. The loop's
 * own requests and the compaction's summary call both use these, so a retry
 * means the same thing wherever it happens.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 16_000];
