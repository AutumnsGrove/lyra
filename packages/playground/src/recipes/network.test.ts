import { expect, test } from "vitest";

import { fetchPageTool, hostilePageTool } from "./network.js";

/**
 * The rows are in `docs/playground.md`: PGS30 and PGS31.
 *
 * `fetch_page` takes the `fetch` its host gives it, so nothing here reaches a network:
 * the fake answers, records what it was asked for, and can fail on purpose. `hostile_page`
 * does not fetch at all — it is the fixture, and the test says so.
 */

function context() {
	return {
		signal: new AbortController().signal,
		runId: "run-1",
		callId: "c1",
		callKey: "run-1\u0000c1",
		state: { notes: {} },
	};
}

function fakeFetch(answer: (url: string) => Response | Promise<Response>): {
	fetch: typeof fetch;
	asked: string[];
} {
	const asked: string[] = [];
	const fetchLike = (async (input: RequestInfo | URL) => {
		const url = String(input);
		asked.push(url);
		return answer(url);
	}) as typeof fetch;
	return { fetch: fetchLike, asked };
}

test("PGS30 fetch_page answers a page's text, and asks its host for the URL", async () => {
	const { fetch: fake, asked } = fakeFetch(
		() => new Response("<h1>the page</h1>", { status: 200 }),
	);
	const tool = fetchPageTool({ fetch: fake });

	const outcome = await tool.execute({ url: "https://example.test/page" }, context());
	expect(outcome.isError).toBe(false);
	expect(outcome.content).toBe("<h1>the page</h1>");
	expect(asked).toEqual(["https://example.test/page"]);
	// A read: it changes nothing, so it is allowed, repeatable, and can join a group.
	expect(tool.policy).toBe("allow");
	expect(tool.parallel).toBe(true);
	expect(tool.safeToRepeat).toBe(true);
});

test("PGS30 a page that fails is an error result the model can adapt to", async () => {
	const notFound = fetchPageTool({
		fetch: fakeFetch(() => new Response("gone", { status: 404 })).fetch,
	});
	const missing = await notFound.execute({ url: "https://example.test/gone" }, context());
	expect(missing.isError).toBe(true);
	expect(missing.content).toContain("404");

	const broken = fetchPageTool({
		fetch: fakeFetch(() => {
			throw new Error("the network is down");
		}).fetch,
	});
	const failed = await broken.execute({ url: "https://example.test/x" }, context());
	expect(failed.isError).toBe(true);
	expect(failed.content).toContain("network is down");
});

test("PGS30 fetch_page refuses a URL that is not the open web", async () => {
	const { fetch: fake, asked } = fakeFetch(() => new Response("nothing", { status: 200 }));
	const tool = fetchPageTool({ fetch: fake });

	// A scheme that is not http(s) is not a page, and a host on the deployment's own
	// network is not the open web: both are refused before the fetch is made, so the
	// Worker's egress cannot be pointed at itself by a model.
	for (const url of [
		"file:///etc/passwd",
		"http://localhost:8080/admin",
		"http://127.0.0.1/",
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data",
		"http://service.internal/",
		"not a url",
	]) {
		const outcome = await tool.execute({ url }, context());
		expect(outcome.isError, url).toBe(true);
	}
	expect(asked).toEqual([]);
});

test("PGS30 a page larger than the cap is cut, and says so", async () => {
	const { fetch: fake } = fakeFetch(() => new Response("x".repeat(300_000), { status: 200 }));
	const tool = fetchPageTool({ fetch: fake });

	const outcome = await tool.execute({ url: "https://example.test/big" }, context());
	expect(outcome.isError).toBe(false);
	expect(outcome.content.length).toBeLessThan(300_000);
	expect(outcome.content).toContain("[cut at");
});

test("PGS31 hostile_page is a fixture, not a guard", async () => {
	const tool = hostilePageTool();
	const outcome = await tool.execute({}, context());

	// The page tells the model to delete every note. The tool does nothing with it: the
	// protection is that `notes_delete` asks a person (PGS26), not that this text is
	// cleaned up. A test that expected otherwise would be testing the wrong thing.
	expect(outcome.isError).toBe(false);
	expect(outcome.content).toContain("notes_delete");
	expect(outcome.details).toMatchObject({ attack: "prompt_injection" });
	expect(tool.apply).toBeUndefined();
	expect(tool.policy).toBe("allow");
});
