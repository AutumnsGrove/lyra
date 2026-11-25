import { expect, test } from "vitest";

import {
	createSessionWorker,
	type DurableObjectNamespaceLike,
	type DurableObjectStubLike,
} from "./session.js";

/**
 * The Worker's router, before any object is asked (docs/protocol.md, HTP09). It
 * reads a command's body to know which object the frame names, and it has to do
 * that without taking more than a frame may hold: the object's own cap comes after
 * this read, so without a cap here a large body costs the Worker its memory first.
 * The namespace is a recording fake, which is all the router needs from it.
 */

interface Recorded {
	namespace: DurableObjectNamespaceLike;
	forwarded: { url: string; body: string }[];
}

function recordingNamespace(): Recorded {
	const forwarded: { url: string; body: string }[] = [];
	const stub: DurableObjectStubLike = {
		fetch: async (request) => {
			forwarded.push({ url: request.url, body: await request.text() });
			return new Response("{}", { status: 200 });
		},
	};
	const namespace: DurableObjectNamespaceLike = {
		idFromName: (name) => ({ toString: () => name }),
		idFromString: (hex) => ({ toString: () => hex }),
		newUniqueId: () => ({ toString: () => "unique" }),
		get: () => stub,
	};
	return { namespace, forwarded };
}

const TOKEN = "a-token-for-a-test";

/**
 * A POST whose body is a stream the router has to read through `request.body`. The
 * declared request type takes a string body only, so the stream is attached to the
 * request after it is made; the router reads `body`, which is where a Worker's real
 * request keeps it. `cancelled` says whether the router gave the stream back
 * instead of reading it to the end, which is how an early stop shows.
 */
function streamed(
	path: string,
	pieces: { size: number; count: number } | "fails",
): { request: Request; cancelled: () => boolean } {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (pieces === "fails") {
				controller.enqueue(new TextEncoder().encode('{"command":"start",'));
				controller.error(new Error("the connection dropped"));
				return;
			}
			for (let piece = 0; piece < pieces.count; piece += 1) {
				controller.enqueue(new Uint8Array(pieces.size).fill(0x20));
			}
			controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	const request = new Request(`https://worker.test${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}` },
		body: "",
	});
	Object.defineProperty(request, "body", { value: body });
	return { request, cancelled: () => cancelled };
}

const worker = (namespace: DurableObjectNamespaceLike) =>
	createSessionWorker({ namespace, tokens: { grove: TOKEN } });

test("HTP09 a body within the cap is forwarded to the object as it was sent", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const frame = JSON.stringify({
		type: "command",
		id: "c1",
		command: "start",
		task: "t",
		input: "x",
	});
	const response = await worker(namespace)(
		new Request("https://worker.test/v1/commands", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: frame,
		}),
	);
	expect(response.status).toBe(200);
	expect(forwarded).toEqual([{ url: "https://worker.test/v1/commands", body: frame }]);
});

test("HTP09 a body over the cap is refused and the stream is given back unread", async () => {
	const { namespace, forwarded } = recordingNamespace();
	// A hundred pieces is far more than a frame may hold; the router must stop early.
	const { request, cancelled } = streamed("/v1/commands", { size: 256 * 1024, count: 100 });
	const response = await worker(namespace)(request);

	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ ok: false, error: { code: "bad_request" } });
	expect(forwarded).toHaveLength(0);
	expect(cancelled()).toBe(true);
});

test("HTP09 an answer body over the cap is refused the same way", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const { request, cancelled } = streamed("/v1/ui_response", { size: 256 * 1024, count: 100 });
	const response = await worker(namespace)(request);
	expect(response.status).toBe(400);
	expect(forwarded).toHaveLength(0);
	expect(cancelled()).toBe(true);
});

test("HTP09 a body that fails while it is read is bad_request, not an exception", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const { request } = streamed("/v1/commands", "fails");
	const response = await worker(namespace)(request);
	expect(response.status).toBe(400);
	// The refusal is about the body being unreadable, not about an empty one.
	const frame = (await response.json()) as { error?: { message?: string } };
	expect(frame.error?.message).toContain("could not be read");
	expect(forwarded).toHaveLength(0);
});
