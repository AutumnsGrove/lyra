import { expect, test } from "vitest";

import { until } from "../../core/run-harness.testing.js";
import { fakeClock, scriptedModel } from "../../testkit/index.js";
import { counterIds } from "../memory/index.js";
import { createCloudflareSession, type DurableObjectStateLike } from "./session.js";

/**
 * The alarm re-follows the sockets that outlived an eviction without waiting on
 * them (docs/adapters.md, CFL27). That follow is detached, so whatever it throws has
 * nobody to catch it: on a Worker an unhandled rejection is logged as an error on a
 * wake that did nothing wrong. A socket whose attachment cannot be read is the case
 * the platform can produce, and the object is a fake with just that one socket.
 */

/** The one part of Node's `process` this test uses; the project declares no Node types. */
declare const process: {
	on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
	off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
};

function stateWithAnUnreadableSocket(): DurableObjectStateLike {
	const unreadable = {
		deserializeAttachment: (): never => {
			throw new Error("the attachment could not be read");
		},
	} as unknown as WebSocket;
	return {
		id: { toString: () => "object-1" },
		storage: {
			sql: { exec: () => ({ toArray: () => [] }) },
			transactionSync: (callback) => callback(),
			getAlarm: async () => null,
			setAlarm: async () => undefined,
			deleteAlarm: async () => undefined,
		},
		acceptWebSocket: () => undefined,
		getWebSockets: () => [unreadable],
	};
}

test("CFL27 an alarm with a socket it cannot read neither fails nor leaves a rejection behind", async () => {
	const session = createCloudflareSession(stateWithAnUnreadableSocket(), {
		recipes: new Map(),
		model: scriptedModel([], { clock: fakeClock() }),
		clock: fakeClock(),
		ids: counterIds(),
		tokens: { acme: "a-token-for-a-test" },
		host: "test-host",
	});

	const rejections: unknown[] = [];
	const record = (reason: unknown): void => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", record);
	try {
		await expect(session.alarm()).resolves.toBeUndefined();
		// An unhandled rejection is reported on a later turn of the event loop, so the
		// check waits a few of them rather than looking at once.
		await until(() => rejections.length > 0, 5);
	} finally {
		process.off("unhandledRejection", record);
	}
	expect(rejections).toEqual([]);
});
