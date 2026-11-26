<script lang="ts">
	/**
	 * The page (issue #60, slices 2 and 3).
	 *
	 * A token box, a sidebar of conversations, and the transcript of what Lyra did with
	 * what a person said. The logic is in `../lib/playground.js` and
	 * `../lib/sessions.js`, which are tested on Node; this file is the skin, so what it
	 * can get wrong is a binding or a click rather than a protocol.
	 *
	 * A conversation is a session (decision 44), named in the URL as `?session=<id>`
	 * (decision 159), and its transcript is rebuilt on load by replaying the record: the
	 * event stream sends every recorded event after the position it is given (HTP05), so
	 * a reload, a second tab and a reconnect all read the same record rather than a copy
	 * the page kept.
	 */
	import { onMount } from "svelte";

	import {
		EMPTY_TRANSCRIPT,
		clearToken,
		readRecord,
		readToken,
		reduce,
		saveToken,
		sendCommand,
		startRun,
		watchEvents,
		type Fetcher,
		type StreamEvent,
		type Transcript,
	} from "../lib/playground.js";
	import {
		createConversation,
		listConversations,
		recipes,
		sessionFromSearch,
		touchConversation,
		withSession,
		type Conversation,
	} from "../lib/sessions.js";
	import { transcriptFrom } from "../lib/transcript.js";

	/** One page of the record, and the most pages a rebuild will read before it stops. */
	const RECORD_PAGE = 20;
	const RECORD_PAGES = 20;

	let token: string | undefined = undefined;
	let draft = "";
	let steerDraft = "";
	let transcript: Transcript = EMPTY_TRANSCRIPT;
	let problem = "";
	let busy = false;
	let mounted = false;
	let controller: AbortController | undefined;

	let conversations: Conversation[] = [];
	let offered: string[] = [];
	let recipe = "";
	let selected: string | undefined = undefined;
	let record: string[] = [];

	const fetched: Fetcher = (url, init) => fetch(url, init);

	onMount(() => {
		mounted = true;
		token = readToken(localStorage);
		if (token !== undefined) {
			void open();
		}
		return () => controller?.abort();
	});

	/** A refusal for the token is the one failure that sends a person back to the box. */
	function refused(status: number): boolean {
		if (status !== 403) {
			return false;
		}
		controller?.abort();
		clearToken(localStorage);
		token = undefined;
		problem = "That token was refused. Enter it again.";
		return true;
	}

	function submitToken(event: SubmitEvent): void {
		event.preventDefault();
		saveToken(localStorage, draft);
		token = readToken(localStorage);
		draft = "";
		problem = token === undefined ? "A token is needed to open the playground." : "";
		if (token !== undefined) {
			void open();
		}
	}

	function forget(): void {
		controller?.abort();
		clearToken(localStorage);
		token = undefined;
		selected = undefined;
		transcript = EMPTY_TRANSCRIPT;
	}

	function keepInUrl(session: string | undefined): void {
		const here = window.location;
		window.history.replaceState(null, "", withSession(here.pathname, here.search, session));
	}

	/** The recipes and the sidebar, then whatever conversation the URL names. */
	async function open(): Promise<void> {
		if (token === undefined) {
			return;
		}
		problem = "";
		const [list, names] = await Promise.all([
			listConversations({ base: "", token, fetcher: fetched }),
			recipes({ base: "", token, fetcher: fetched }),
		]);
		if (!list.ok) {
			if (refused(list.error.status)) {
				return;
			}
			problem = list.error.message;
			return;
		}
		conversations = list.value;
		if (names.ok) {
			offered = names.value;
			if (recipe === "") {
				recipe = offered[0] ?? "";
			}
		} else if (!refused(names.error.status)) {
			problem = names.error.message;
		}

		const named = sessionFromSearch(window.location.search);
		if (named !== undefined) {
			await select(named);
		}
	}

	/**
	 * Open one conversation: its id into the URL, its transcript from a replayed stream,
	 * and its record into the panel. A conversation whose id the index does not hold is
	 * still opened, because a person can be looking at a run that predates the index.
	 */
	async function select(session: string): Promise<void> {
		controller?.abort();
		controller = undefined;
		selected = session;
		keepInUrl(session);
		transcript = EMPTY_TRANSCRIPT;
		record = [];
		problem = "";
		const entries = await loadEntries(session);
		if (entries !== undefined) {
			// The record is the truth on load: it holds both sides of the conversation,
			// which the event stream does not (`user_message` is not a protocol event).
			transcript = transcriptFrom(entries);
			// The stream is exclusive of the position it is given, and a record with no
			// entries has no position to skip: `-1` is not a `Last-Event-ID` the protocol
			// accepts, so an empty record starts the stream at zero.
			await follow(session, Math.max(0, entries.length - 1));
		}
	}

	/** Back to a new conversation: no session in the URL, an empty transcript. */
	function startFresh(): void {
		controller?.abort();
		controller = undefined;
		selected = undefined;
		transcript = EMPTY_TRANSCRIPT;
		record = [];
		problem = "";
		keepInUrl(undefined);
	}

	/**
	 * Follow a session's events from `since`, reopening once from the position the first
	 * stream gave this page if it drops. A stop is the page's own doing and ends the loop
	 * silently. `since` is the last entry the page rebuilt from, so nothing is drawn
	 * twice and nothing written since the read is missed: the stream replays from it.
	 */
	async function follow(session: string, since = 0): Promise<void> {
		if (token === undefined) {
			return;
		}
		const me = new AbortController();
		controller = me;
		let after: string | undefined = String(since);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const watched = await watchEvents({
				base: "",
				token,
				session,
				fetcher: fetched,
				signal: me.signal,
				...(after === undefined ? {} : { lastEventId: after }),
				onEvent: (event: StreamEvent) => {
					transcript = reduce(transcript, event);
				},
			});
			if (me.signal.aborted) {
				return;
			}
			if (watched.ok) {
				// A stream the server closed having sent nothing new is finished, not
				// dropped; reopening it would only ask for the same record again.
				if (watched.lastEventId === undefined || watched.lastEventId === after) {
					return;
				}
				after = watched.lastEventId;
				continue;
			}
			if (refused(watched.error.status)) {
				return;
			}
			problem = watched.error.message;
			return;
		}
	}

	/**
	 * A session's whole record, one page at a time (CMD12), and nothing when it cannot
	 * be read. It stops at the page cap rather than following a cursor forever.
	 */
	async function loadEntries(session: string): Promise<Record<string, unknown>[] | undefined> {
		if (token === undefined) {
			return undefined;
		}
		const all: Record<string, unknown>[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < RECORD_PAGES; page += 1) {
			const read = await readRecord({
				base: "",
				token,
				fetcher: fetched,
				session,
				limit: RECORD_PAGE,
				cursor,
				id: `m${Date.now()}-${page}`,
			});
			if (!read.ok) {
				if (!refused(read.error.status)) {
					problem = read.error.message;
				}
				return undefined;
			}
			all.push(...read.value.entries);
			cursor = read.value.cursor;
			if (cursor === null) {
				break;
			}
		}
		record = all.map((entry) => JSON.stringify(entry));
		return all;
	}

	/** The panel again, without touching the transcript a person is reading. */
	async function refreshRecord(): Promise<void> {
		if (selected !== undefined) {
			await loadEntries(selected);
		}
	}

	/** The first message of a new conversation: mint it, name it in the URL, start it. */
	async function startNew(): Promise<void> {
		// The picker is the source of truth, and the first recipe is the default: a select
		// that has not synced its binding yet must not send a run with no recipe.
		const chosen = recipe === "" ? (offered[0] ?? "") : recipe;
		if (token === undefined || busy || draft.trim() === "" || chosen === "") {
			return;
		}
		busy = true;
		problem = "";
		const label = draft.trim();
		const input = label;
		const created = await createConversation({
			base: "",
			token,
			fetcher: fetched,
			recipe: chosen,
			label,
		});
		if (!created.ok) {
			busy = false;
			if (refused(created.error.status)) {
				return;
			}
			problem = created.error.message;
			return;
		}
		selected = created.value;
		keepInUrl(selected);
		draft = "";
		transcript = { rows: [{ kind: "person", text: input }], status: { state: "running" } };

		const started = await startRun({
			base: "",
			token,
			task: chosen,
			input,
			session: created.value,
			fetcher: fetched,
		});
		busy = false;
		if (!started.ok) {
			if (refused(started.error.status)) {
				return;
			}
			problem = started.error.message;
			transcript = { ...transcript, status: { state: "failed" } };
			return;
		}
		// The record is empty until the run writes its first entry, so the stream starts
		// at the beginning rather than at the end of a page the page never read.
		await follow(created.value, 0);
		// A new array rather than `unshift`, because Svelte's legacy mode invalidates on
		// assignment: a mutated array is a sidebar that does not draw the new conversation.
		conversations = [
			{ session: created.value, label, recipe: chosen, lastUsed: Date.now() },
			...conversations,
		];
	}

	/** A message in an open conversation: a follow-up, which starts the next run if none is going. */
	async function sendFollowUp(): Promise<void> {
		if (token === undefined || selected === undefined || draft.trim() === "") {
			return;
		}
		const text = draft.trim();
		draft = "";
		transcript = { ...transcript, rows: [...transcript.rows, { kind: "person", text }] };
		const touched = await touchConversation({
			base: "",
			token,
			fetcher: fetched,
			session: selected,
		});
		if (!touched.ok && refused(touched.error.status)) {
			return;
		}
		const sent = await sendCommand({
			base: "",
			token,
			fetcher: fetched,
			command: "follow_up",
			session: selected,
			text,
			id: `c${Date.now()}`,
		});
		if (!sent.ok) {
			if (!refused(sent.error.status)) {
				problem = sent.error.message;
			}
			return;
		}
		transcript = { ...transcript, status: { state: "running" } };
	}

	async function steer(): Promise<void> {
		if (token === undefined || selected === undefined || steerDraft.trim() === "") {
			return;
		}
		const text = steerDraft.trim();
		steerDraft = "";
		const sent = await sendCommand({
			base: "",
			token,
			fetcher: fetched,
			command: "steer",
			session: selected,
			text,
			id: `c${Date.now()}`,
		});
		if (!sent.ok && !refused(sent.error.status)) {
			problem = sent.error.message;
		}
	}

	async function stop(): Promise<void> {
		if (token === undefined || selected === undefined) {
			return;
		}
		const sent = await sendCommand({
			base: "",
			token,
			fetcher: fetched,
			command: "abort",
			session: selected,
			id: `c${Date.now()}`,
		});
		if (!sent.ok && !refused(sent.error.status)) {
			problem = sent.error.message;
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
		<div class="layout">
			<aside>
				<h2>Conversations</h2>
				<button type="button" onclick={startFresh}>New conversation</button>
				<ul>
					{#each conversations as conversation (conversation.session)}
						<li>
							<button
								type="button"
								class:selected={conversation.session === selected}
								onclick={() => void select(conversation.session)}
							>
								{conversation.label}
								<small>{conversation.recipe}</small>
							</button>
						</li>
					{/each}
				</ul>
				<button type="button" onclick={forget}>Forget token</button>
			</aside>

			<section>
				{#if selected === undefined}
					<form
						onsubmit={(event) => {
							event.preventDefault();
							void startNew();
						}}
					>
						<label for="recipe">Recipe</label>
						<select id="recipe" bind:value={recipe}>
							{#each offered as name (name)}
								<option value={name}>{name}</option>
							{/each}
						</select>
						<label for="question">Ask Lyra</label>
						<input id="question" bind:value={draft} disabled={busy} placeholder="what time is it?" />
						<button type="submit" disabled={busy || offered.length === 0}>{busy ? "Running…" : "Run"}</button>
					</form>
				{:else}
					<form
						onsubmit={(event) => {
							event.preventDefault();
							void sendFollowUp();
						}}
					>
						<label for="question">Ask Lyra</label>
						<input id="question" bind:value={draft} placeholder="say something else" />
						<button type="submit">Send</button>
					</form>
					{#if transcript.status.state === "running"}
						<form
							onsubmit={(event) => {
								event.preventDefault();
								void steer();
							}}
						>
							<label for="steer">Steer</label>
							<input id="steer" bind:value={steerDraft} placeholder="say it differently, at the next gap" />
							<button type="submit">Steer</button>
						</form>
						<button type="button" onclick={() => void stop()}>Stop</button>
					{/if}
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

				{#if selected !== undefined}
					<details class="record">
						<summary>Record ({record.length})</summary>
						<button type="button" onclick={() => void refreshRecord()}>Refresh record</button>
						{#each record as line, index (index)}
							<pre>{line}</pre>
						{/each}
					</details>
				{/if}
			</section>
		</div>
	{/if}

	{#if problem !== ""}
		<p class="problem" role="alert">{problem}</p>
	{/if}
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		max-width: 60rem;
		margin: 0 auto;
		padding: 1.5rem;
		line-height: 1.5;
	}

	h1 {
		font-size: 1.35rem;
		margin-bottom: 0.25rem;
	}

	h2 {
		font-size: 0.9rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #555;
	}

	.note {
		color: #555;
		margin-top: 0;
	}

	.layout {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		align-items: flex-start;
	}

	aside {
		flex: 1 1 14rem;
		min-width: 12rem;
	}

	aside ul {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
	}

	aside li button {
		width: 100%;
		text-align: left;
	}

	aside li button.selected {
		font-weight: 600;
	}

	aside small {
		color: #777;
		margin-left: 0.4rem;
	}

	section {
		flex: 3 1 26rem;
	}

	form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 0.75rem 0;
	}

	label {
		font-size: 0.85rem;
		width: 100%;
	}

	input,
	select {
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
		font-size: 0.75rem;
	}
</style>
