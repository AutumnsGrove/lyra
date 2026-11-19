import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

import { defineTool } from "../../core/tool.js";
import { runTask } from "../../core/run.js";
import { createFinishTool } from "../../core/finish.js";
import { counterIds, memoryStorage } from "../memory/index.js";
import { fakeClock, scriptedModel } from "../../testkit/index.js";
import type { SecretsSlot } from "../../core/slots.js";
import { bindingSecrets } from "./secrets.js";

/**
 * CFL19 to CFL21 in `docs/adapters.md`: secrets are the Worker's own bindings, read
 * by name. The made-up value lives in the test `wrangler.jsonc`, never in a secret
 * and never in this file.
 */

test("CFL19 a binding is read by name", async () => {
	const secrets = bindingSecrets(env);
	expect(await secrets.get("FIXTURE_TOKEN")).toBe("made-up-for-a-test");
});

test("CFL20 a missing binding is nothing, and a tool names the secret but never a value", async () => {
	expect(await bindingSecrets(env).get("NOT_A_BINDING")).toBeUndefined();

	// A tool that needs a secret, in the shape a recipe's tool has.
	function tokenTool(secrets: SecretsSlot) {
		return defineTool({
			name: "use_token",
			description: "Use a token the host holds.",
			parameters: { type: "object", properties: {} } as const,
			async execute() {
				const token = await secrets.get("FIXTURE_TOKEN");
				if (token === undefined) {
					return { isError: true, content: "FIXTURE_TOKEN is not held by this host" };
				}
				return { isError: false, content: `used a token of ${token.length} characters` };
			},
		});
	}

	async function runWith(secrets: SecretsSlot) {
		const storage = memoryStorage();
		const clock = fakeClock();
		const result = await runTask({
			runId: "run-1",
			task: "secrets",
			host: "fixture",
			input: "go",
			system: "you are a test",
			tools: [tokenTool(secrets), createFinishTool({ check: () => ({ ok: true }) })],
			model: scriptedModel(
				[
					{ toolCalls: [{ id: "c1", name: "use_token", args: {} }] },
					{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
				],
				{ clock },
			),
			storage,
			clock,
			ids: counterIds(),
		});
		const saved = await storage.read();
		return { result, lines: saved.ok ? saved.value : [] };
	}

	// The positive case first: the token really was held and used, so the scan below
	// is looking at a record that had a value available to leak.
	const held = await runWith(bindingSecrets(env));
	expect(held.result.reason).toBe("done");
	expect(
		held.lines.some((line) =>
			line.includes(`used a token of ${env.FIXTURE_TOKEN.length} characters`),
		),
	).toBe(true);
	expect(held.lines.some((line) => line.includes("made-up-for-a-test"))).toBe(false);

	// The sad case: a host that does not hold it says so by name, and no value exists
	// to leak.
	const missing = await runWith(bindingSecrets({}));
	expect(missing.result.reason).toBe("done");
	const refused = missing.lines.find((line) => line.includes("is not held"));
	expect(refused).toContain("FIXTURE_TOKEN");
});

test("CFL21 a non-string binding and a prototype name are not secrets", async () => {
	const secrets = bindingSecrets({ FIXTURE_SESSION: {}, constructor: {} });
	expect(await secrets.get("FIXTURE_SESSION")).toBeUndefined();
	expect(await secrets.get("constructor")).toBeUndefined();
	expect(await secrets.get("__proto__")).toBeUndefined();
	expect(await secrets.get("toString")).toBeUndefined();
});
