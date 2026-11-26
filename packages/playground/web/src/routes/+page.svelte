<script lang="ts">
	/**
	 * The page (issue #60, slice 2).
	 *
	 * A token box, a question, and the transcript of what Lyra did with it. The logic is
	 * in `../lib/playground.js`, which is tested on Node; this file is the skin, so what
	 * it can get wrong is a binding or a click rather than a protocol.
	 */
	import { onMount } from "svelte";

	import {
		EMPTY_TRANSCRIPT,
		clearToken,
		readToken,
		reduce,
		saveToken,
		startRun,
		watchEvents,
		type Fetcher,
		type Transcript,
	} from "../lib/playground.js";

	const TASK = "tool-table";
	const PLACEHOLDER = "What time is it, and what is 6 times 7?";

	let token: string | undefined = undefined;
	let draft = "";
	let question = PLACEHOLDER;
	let transcript: Transcript = EMPTY_TRANSCRIPT;
	let problem = "";
	let busy = false;
	let mounted = false;
	let controller: AbortController | undefined;

	onMount(() => {
		mounted = true;
		token = readToken(localStorage);
		return () => controller?.abort();
	});

	function submitToken(event: SubmitEvent): void {
		event.preventDefault();
		saveToken(localStorage, draft);
		token = readToken(localStorage);
		draft = "";
		problem = token === undefined ? "A token is needed to open the playground." : "";
	}

	function forget(): void {
		controller?.abort();
		clearToken(localStorage);
		token = undefined;
		transcript = EMPTY_TRANSCRIPT;
	}

	/** A refusal for the token is the one failure that sends a person back to the box. */
	function refused(status: number): boolean {
		if (status !== 403) {
			return false;
		}
		clearToken(localStorage);
		token = undefined;
		problem = "That token was refused. Enter it again.";
		return true;
	}

	async function run(): Promise<void> {
		if (token === undefined || busy) {
			return;
		}
		busy = true;
		problem = "";
		transcript = { rows: [{ kind: "person", text: question }], status: { state: "running" } };

		const fetched: Fetcher = (url, init) => fetch(url, init);
		const started = await startRun({
			base: "",
			token,
			task: TASK,
			input: question,
			fetcher: fetched,
		});
		if (!started.ok) {
			busy = false;
			if (refused(started.error.status)) {
				return;
			}
			problem = started.error.message;
			transcript = { ...transcript, status: { state: "failed" } };
			return;
		}

		controller = new AbortController();
		const watched = await watchEvents({
			base: "",
			token,
			session: started.value.session,
			fetcher: fetched,
			signal: controller.signal,
			onEvent: (event) => {
				transcript = reduce(transcript, event);
			},
		});
		busy = false;
		if (!watched.ok) {
			if (refused(watched.error.status)) {
				return;
			}
			problem = watched.error.message;
		}
	}
</script>

<main>
	<h1>Lyra playground</h1>
	<p class="note">A rig, not a product: one Worker, a real model, and a record you can watch.</p>

	{#if !mounted}
		<p class="note">Loading…</p>
	{:else if token === undefined}
		<form onsubmit={submitToken}>
			<label for="token">Token</label>
			<input id="token" bind:value={draft} type="password" autocomplete="off" placeholder="the playground's token" />
			<button type="submit">Open</button>
		</form>
	{:else}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void run();
			}}
		>
			<label for="question">Ask Lyra</label>
			<input id="question" bind:value={question} disabled={busy} />
			<button type="submit" disabled={busy}>{busy ? "Running…" : "Run"}</button>
			<button type="button" onclick={forget}>Forget token</button>
		</form>
	{/if}

	{#if problem !== ""}
		<p class="problem" role="alert">{problem}</p>
	{/if}

	{#if transcript.rows.length > 0}
		<ol class="transcript">
			{#each transcript.rows as row}
				{#if row.kind === "person"}
					<li class="person">You: {row.text}</li>
				{:else if row.kind === "assistant"}
					<li class="assistant">
						{#if row.reasoning}<details><summary>thinking</summary><pre>{row.reasoning}</pre></details>{/if}
						{#if row.text}<span>{row.text}</span>{/if}
					</li>
				{:else if row.kind === "tool"}
					<li class="tool">calls <code>{row.name}</code>{#if row.arguments}<code>{row.arguments}</code>{/if}</li>
				{:else if row.kind === "result"}
					<li class:error={row.isError} class="result">
						<code>{row.name}</code> answered <code>{row.text}</code>
					</li>
				{:else}
					<li class="problem">{row.text}</li>
				{/if}
			{/each}
		</ol>
	{/if}

	{#if transcript.status.state !== "idle"}
		<p class="status">
			{transcript.status.state}{#if transcript.status.detail} · {transcript.status.detail}{/if}{#if transcript.status.turns !== undefined} · {transcript.status.turns} turn(s){/if}{#if transcript.status.costUsd !== undefined} · ${transcript.status.costUsd}{/if}
		</p>
	{/if}
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		max-width: 46rem;
		margin: 0 auto;
		padding: 1.5rem;
		line-height: 1.5;
	}

	h1 {
		font-size: 1.35rem;
		margin-bottom: 0.25rem;
	}

	.note {
		color: #555;
		margin-top: 0;
	}

	form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 1rem 0;
	}

	label {
		font-size: 0.85rem;
		width: 100%;
	}

	input {
		flex: 1 1 16rem;
		padding: 0.4rem;
	}

	button {
		padding: 0.4rem 0.75rem;
	}

	.transcript {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	.transcript li {
		border-left: 3px solid #ccc;
		padding: 0.25rem 0.6rem;
	}

	.person {
		border-left-color: #4a6fa5;
	}

	.tool {
		border-left-color: #b58900;
	}

	.result {
		border-left-color: #3c8c4a;
	}

	.error,
	.problem {
		border-left-color: #b3261e;
		color: #b3261e;
	}

	.status {
		color: #555;
		font-size: 0.9rem;
	}

	pre {
		white-space: pre-wrap;
	}
</style>
