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
	import { afterUpdate, onMount } from "svelte";

	import {
		EMPTY_TRANSCRIPT,
		answerRequest,
		callState,
		clearToken,
		decideProposal,
		nextId,
		pendingCards,
		readRecord,
		readToken,
		reduce,
		saveToken,
		sendCommand,
		spendOf,
		startRun,
		watchEvents,
		type Fetcher,
		type Row,
		type StreamEvent,
		type Transcript,
	} from "../lib/playground.js";
	import {
		createConversation,
		listConversations,
		readCap,
		recipes,
		reportSpend,
		sessionFromSearch,
		touchConversation,
		withSession,
		type CapState,
		type Conversation,
	} from "../lib/sessions.js";
	import { transcriptFrom } from "../lib/transcript.js";
	import { capLine, statusWords } from "../lib/words.js";

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
	/** The note or answer typed into a card, by request id. */
	let drafts: Record<string, string> = {};
	/** Today's spend and the cap, as the deployment counts them (slice 7). */
	let cap: CapState | undefined = undefined;
	/** The last total reported for each run, so a parked run's resume is counted once. */
	let reported = new Map<string, number>();

	/** The sidebar as a drawer, which only matters on a narrow screen. */
	let drawer = false;
	let scroller: HTMLElement | undefined;
	/** True while the person is reading the end of the transcript, so new rows follow them and a scroll up is left alone. */
	let following = true;

	$: words = statusWords(transcript.status);
	$: spend = cap === undefined ? undefined : capLine(cap);
	$: title = conversations.find((entry) => entry.session === selected)?.label ?? "Conversation";
	$: waiting = transcript.rows.filter(
		(row) => (row.kind === "card" || row.kind === "proposal") && row.state === "open",
	).length;

	afterUpdate(() => {
		if (scroller !== undefined && following) {
			scroller.scrollTop = scroller.scrollHeight;
		}
	});

	function onScroll(): void {
		if (scroller !== undefined) {
			following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
		}
	}

	/** Copies what a person can see in a long block. A refusal (no permission, no clipboard) is not worth a banner. */
	function copy(text: string): void {
		void navigator.clipboard?.writeText(text).catch(() => undefined);
	}

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
		const [list, names, spend] = await Promise.all([
			listConversations({ base: "", token, fetcher: fetched }),
			recipes({ base: "", token, fetcher: fetched }),
			readCap({ base: "", token, fetcher: fetched }),
		]);
		if (spend.ok) {
			cap = spend.value;
		} else if (!refused(spend.error.status)) {
			problem = spend.error.message;
		}
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
		drawer = false;
		following = true;
		keepInUrl(session);
		transcript = EMPTY_TRANSCRIPT;
		record = [];
		problem = "";
		const entries = await loadEntries(session);
		// A person can switch conversations while the record is in flight; a read for the
		// one they left must not write into the one they are reading now.
		if (selected !== session) {
			return;
		}
		if (entries !== undefined) {
			// The record is the truth on load: it holds both sides of the conversation,
			// which the event stream does not (`user_message` is not a protocol event).
			transcript = transcriptFrom(entries);
			// The record read can stop at its page cap, and a card is the one thing a person
			// has to act on, so the server is asked what can be answered now (CMD09) and
			// anything the rebuild missed is drawn.
			await mergePending(session);
			// The stream is exclusive of the position it is given, and a record with no
			// entries has no position to skip: `-1` is not a `Last-Event-ID` the protocol
			// accepts, so an empty record starts the stream at zero.
			await follow(session, Math.max(0, entries.length - 1));
		}
	}

	/** The cards the session can answer now, minus the ones the transcript already holds. */
	async function mergePending(session: string): Promise<void> {
		if (token === undefined) {
			return;
		}
		const pending = await pendingCards({
			base: "",
			token,
			fetcher: fetched,
			session,
			id: nextId("p"),
		});
		// The same race the record read has: this may resolve after a switch.
		if (selected !== session) {
			return;
		}
		if (!pending.ok) {
			if (!refused(pending.error.status)) {
				problem = pending.error.message;
			}
			return;
		}
		const held = new Set(
			transcript.rows.flatMap((row) =>
				row.kind === "card" ? [row.request] : row.kind === "proposal" ? [row.proposal] : [],
			),
		);
		const extra = pending.value.cards.filter((card) =>
			card.kind === "card" ? !held.has(card.request) : card.kind === "proposal" ? !held.has(card.proposal) : false,
		);
		if (extra.length > 0) {
			transcript = { ...transcript, rows: [...transcript.rows, ...extra] };
		}
	}

	/** One card, by request id, replaced in the transcript when its state changes. */
	function settle(request: string, next: { state: "approved" | "denied" | "expired"; answer?: string }): void {
		transcript = {
			...transcript,
			rows: transcript.rows.map((row) =>
				row.kind === "card" && row.request === request && row.state === "open"
					? { ...row, ...next }
					: row,
			),
		};
	}

	function draftOf(request: string): string {
		return drafts[request] ?? "";
	}

	function setDraft(request: string, event: Event): void {
		const target = event.target;
		if (target instanceof HTMLInputElement) {
			drafts = { ...drafts, [request]: target.value };
		}
	}

	/**
	 * Answer a card: an approval's yes or no, or a question's text.
	 *
	 * A `conflict` means somebody answered first and a `not_found` means the id expired;
	 * both close the card rather than leaving a button that can never work.
	 */
	async function answer(row: Extract<Row, { kind: "card" }>, ok: boolean): Promise<void> {
		if (token === undefined || selected === undefined) {
			return;
		}
		const text = draftOf(row.request).trim();
		const answered = await answerRequest({
			base: "",
			token,
			fetcher: fetched,
			session: selected,
			request: row.request,
			ok,
			...(row.asks === "question" ? { text } : {}),
			...(row.asks === "approve" && text !== "" ? { note: text } : {}),
			id: nextId("a"),
		});
		if (!answered.ok) {
			if (refused(answered.error.status)) {
				return;
			}
			if (answered.error.code === "conflict" || answered.error.code === "not_found") {
				settle(row.request, { state: "expired" });
			}
			problem = answered.error.message;
			return;
		}
		drafts = { ...drafts, [row.request]: "" };
		settle(row.request, {
			state: ok ? (row.asks === "approve" ? "approved" : "approved") : "denied",
			...(text === "" ? {} : { answer: text }),
		});
	}

	async function choose(row: Extract<Row, { kind: "card" }>, id: string): Promise<void> {
		if (token === undefined || selected === undefined) {
			return;
		}
		const answered = await answerRequest({
			base: "",
			token,
			fetcher: fetched,
			session: selected,
			request: row.request,
			ok: true,
			ids: [id],
			id: nextId("a"),
		});
		if (!answered.ok) {
			if (refused(answered.error.status)) {
				return;
			}
			if (answered.error.code === "conflict" || answered.error.code === "not_found") {
				settle(row.request, { state: "expired" });
			}
			problem = answered.error.message;
			return;
		}
		const option = row.options?.find((candidate) => candidate.id === id);
		settle(row.request, { state: "approved", ...(option === undefined ? {} : { answer: option.label }) });
	}

	/** A proposal's decision, which is a command rather than an answer (CMD10). */
	async function decide(row: Extract<Row, { kind: "proposal" }>, decision: "accept" | "reject"): Promise<void> {
		if (token === undefined || selected === undefined) {
			return;
		}
		const decided = await decideProposal({
			base: "",
			token,
			fetcher: fetched,
			session: selected,
			proposal: row.proposal,
			decision,
			...(draftOf(row.proposal).trim() === "" ? {} : { note: draftOf(row.proposal).trim() }),
			id: nextId("d"),
		});
		drafts = { ...drafts, [row.proposal]: "" };
		if (!decided.ok) {
			if (!refused(decided.error.status)) {
				problem = decided.error.message;
			}
			return;
		}
		transcript = {
			...transcript,
			rows: transcript.rows.map((entry) =>
				entry.kind === "proposal" && entry.proposal === row.proposal && entry.state === "open"
					? { ...entry, state: decision === "accept" ? "accepted" : "rejected" }
					: entry,
			),
		};
	}

	/** Back to a new conversation: no session in the URL, an empty transcript. */
	function startFresh(): void {
		drawer = false;
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
					void reportRun(event);
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
	 * Tell the deployment what a run cost, once per segment's worth, when its end arrives.
	 *
	 * A `run_end` reports the whole run's usage, so a run that parks and resumes carries a
	 * cumulative total each time; `spendOf` gives the difference, which is also why a
	 * replayed end adds nothing. A run that made no call and reported no cost adds nothing,
	 * rather than latching the day unpriced (findings on #99).
	 */
	async function reportRun(event: StreamEvent): Promise<void> {
		if (token === undefined) {
			return;
		}
		const run = typeof event["run"] === "string" ? event["run"] : "";
		const report = spendOf(event, run === "" ? undefined : reported.get(run));
		if (report === undefined) {
			return;
		}
		if (report.amount !== undefined) {
			reported = new Map(reported).set(report.run, (reported.get(report.run) ?? 0) + report.amount);
		}
		const spent =
			report.amount === undefined
				? await reportSpend({ base: "", token, fetcher: fetched, unpriced: true })
				: await reportSpend({ base: "", token, fetcher: fetched, amount: report.amount });
		if (spent.ok) {
			cap = spent.value;
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
				id: nextId("m"),
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
			id: nextId("c"),
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
			id: nextId("c"),
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
			id: nextId("c"),
		});
		if (!sent.ok && !refused(sent.error.status)) {
			problem = sent.error.message;
		}
	}

</script>

<div class="app">
	<header class="bar">
		{#if mounted && token !== undefined}
			<button
				type="button"
				class="icon menu"
				aria-label="Conversations"
				aria-expanded={drawer}
				onclick={() => (drawer = !drawer)}>☰</button
			>
		{/if}
		<div class="brand">
			<span class="mark" aria-hidden="true">◈</span>
			<strong>Lyra</strong>
			<span class="dim">playground</span>
		</div>
		{#if spend !== undefined}
			<div class="cap" class:over={spend.over}>
				<div class="meter" aria-hidden="true"><span style="width: {Math.round(spend.fraction * 100)}%"></span></div>
				<span class="cap-text">{spend.text}</span>
			</div>
		{/if}
	</header>

	{#if problem !== ""}
		<p class="banner" role="alert">{problem}</p>
	{/if}

	{#if !mounted}
		<div class="center"><p class="dim">Loading…</p></div>
	{:else if token === undefined}
		<div class="center">
			<form class="gate" onsubmit={submitToken}>
				<h1>Open the playground</h1>
				<p>
					This page runs Lyra against a real model, so it sits behind one shared access token. It is the token
					set on this Worker, and it is sent only to this site.
				</p>
				<label for="token">Token</label>
				<input id="token" bind:value={draft} type="password" autocomplete="off" placeholder="the playground's token" />
				<button type="submit" class="btn primary">Open</button>
				<p class="fine">
					It is kept in this browser's local storage until you forget it or the Worker refuses it. Do not paste a
					token here that you would not hand to this one Worker.
				</p>
			</form>
		</div>
	{:else}
		<div class="shell" class:open={drawer}>
			<aside class="side">
				<button type="button" class="btn primary wide" onclick={startFresh}>New conversation</button>
				<h2>Conversations</h2>
				{#if conversations.length === 0}
					<p class="dim empty">None yet. Start one and it is listed here.</p>
				{/if}
				<ul>
					{#each conversations as conversation (conversation.session)}
						<li>
							<button
								type="button"
								class="entry"
								class:selected={conversation.session === selected}
								onclick={() => void select(conversation.session)}
							>
								<span class="entry-label">{conversation.label}</span>
								<small>{conversation.recipe}</small>
							</button>
						</li>
					{/each}
				</ul>
				<button type="button" class="btn ghost wide" onclick={forget}>Forget token</button>
			</aside>
			{#if drawer}
				<button type="button" class="scrim" aria-label="Close conversations" tabindex="-1" onclick={() => (drawer = false)}
				></button>
			{/if}

			<section class="convo">
				{#if selected === undefined}
					<div class="scroll">
						<div class="hero">
							<h1>What should Lyra do?</h1>
							<p>
								Pick a recipe, say what you want, and watch the loop work: each tool call fills in with how long it
								took, and anything that needs you stops and asks.
							</p>
						</div>
					</div>
					<div class="dock">
						<form
							class="compose new"
							onsubmit={(event) => {
								event.preventDefault();
								void startNew();
							}}
						>
							<div class="field narrow">
								<label for="recipe">Recipe</label>
								<select id="recipe" bind:value={recipe}>
									{#each offered as name (name)}
										<option value={name}>{name}</option>
									{/each}
								</select>
							</div>
							<div class="field grow">
								<label for="question" class="sr-only">Ask Lyra</label>
								<input id="question" bind:value={draft} disabled={busy} placeholder="what time is it?" />
							</div>
							<button type="submit" class="btn primary" disabled={busy || offered.length === 0}>
								{busy ? "Running…" : "Run"}
							</button>
						</form>
					</div>
				{:else}
					<div class="convo-head">
						<div class="convo-title">
							<h2>{title}</h2>
						</div>
						{#if transcript.status.state !== "idle"}
							<div class="status" data-tone={words.tone}>
								<span class="dot" aria-hidden="true"></span>
								<strong>{words.label}</strong>
								{#if words.hint !== ""}<span class="hint">{words.hint}</span>{/if}
							</div>
						{/if}
						{#if transcript.status.state === "running"}
							<button type="button" class="btn danger" onclick={() => void stop()}>Stop</button>
						{/if}
					</div>

					<div class="scroll" bind:this={scroller} onscroll={onScroll}>
						{#if transcript.rows.length === 0}
							<p class="dim empty">Nothing here yet.</p>
						{/if}
						<ol class="transcript">
							{#each transcript.rows as row}
								{#if row.kind === "person"}
									<li class="person"><p>{row.text}</p></li>
								{:else if row.kind === "assistant"}
									<li class="assistant">
										{#if row.reasoning}
											<details class="thought"><summary>thinking</summary><p>{row.reasoning}</p></details>
										{/if}
										{#if row.text}<p>{row.text}</p>{/if}
									</li>
								{:else if row.kind === "tool"}
									<li class="tool" class:error={row.isError === true}>
										<div class="call">
											<code>{row.name}</code>
											<span class="state chip" data-state={callState(row, transcript.status.state)}
												>{callState(row, transcript.status.state)}</span
											>
											{#if row.durationMs !== undefined}
												<span class="duration">{row.durationMs} ms</span>
											{/if}
										</div>
										{#if row.arguments !== undefined && row.arguments !== ""}
											<details class="more">
												<summary>arguments</summary>
												<pre>{row.arguments}</pre>
											</details>
										{/if}
										{#if row.result !== undefined}
											<div class="out">
												<pre>{row.result}</pre>
												<button type="button" class="mini" onclick={() => copy(row.result ?? "")}>Copy</button>
											</div>
										{:else if callState(row, transcript.status.state) === "running"}
											<p class="state">waiting for the result…</p>
										{:else}
											<p class="state">no result: the run moved on or was stopped</p>
										{/if}
									</li>
								{:else if row.kind === "card"}
									<li class="card ask" data-open={row.state === "open"}>
										<div class="ask-head">
											{#if row.state === "open"}<span class="badge">Needs you</span>{/if}
											<p class="card-title">{row.title}</p>
										</div>
										<p class="ask-body">{row.message}</p>
										{#if row.tool}
											<p class="ask-meta">tool <code>{row.tool}</code></p>
										{/if}
										{#if row.args}
											<details class="more">
												<summary>arguments</summary>
												<pre>{row.args}</pre>
											</details>
										{/if}
										{#if row.state === "open"}
											{#if row.asks === "choice"}
												<div class="choices">
													{#each row.options ?? [] as option (option.id)}
														<button type="button" class="btn" onclick={() => void choose(row, option.id)}
															>{option.label}</button
														>
													{/each}
												</div>
											{:else}
												<div class="ask-controls">
													<input
														aria-label={row.asks === "approve" ? "Note" : "Answer"}
														value={draftOf(row.request)}
														oninput={(event) => setDraft(row.request, event)}
														placeholder={row.asks === "approve" ? "a note the model will read (optional)" : "your answer"}
													/>
													<button type="button" class="btn primary" onclick={() => void answer(row, true)}>
														{row.asks === "approve" ? "Approve" : "Send answer"}
													</button>
													{#if row.asks === "approve"}
														<button type="button" class="btn" onclick={() => void answer(row, false)}>Deny</button>
													{/if}
												</div>
											{/if}
										{:else}
											<p class="state settled-state" data-state={row.state}>
												{row.state}{#if row.answer} · {row.answer}{/if}
											</p>
										{/if}
									</li>
								{:else if row.kind === "proposal"}
									<li class="card ask" data-open={row.state === "open"}>
										<div class="ask-head">
											{#if row.state === "open"}<span class="badge">Needs you</span>{/if}
											<p class="card-title">a proposal</p>
										</div>
										<div class="out">
											<pre>{row.payload}</pre>
											<button type="button" class="mini" onclick={() => copy(row.payload)}>Copy</button>
										</div>
										{#if row.evidence.length > 0}
											<p class="ask-meta">evidence: {row.evidence.join(", ")}</p>
										{/if}
										{#if row.state === "open"}
											<div class="ask-controls">
												<input
													aria-label="Proposal note"
													value={draftOf(row.proposal)}
													oninput={(event) => setDraft(row.proposal, event)}
													placeholder="a note the model will read (optional)"
												/>
												<button type="button" class="btn primary" onclick={() => void decide(row, "accept")}>Accept</button>
												<button type="button" class="btn" onclick={() => void decide(row, "reject")}>Reject</button>
											</div>
										{:else}
											<p class="state settled-state" data-state={row.state}>
												{row.state}{#if row.note} · {row.note}{/if}
											</p>
										{/if}
									</li>
								{:else}
									<li class="problem-row">{row.text}</li>
								{/if}
							{/each}
						</ol>

						<details class="record">
							<summary>Record ({record.length})</summary>
							<button type="button" class="btn ghost" onclick={() => void refreshRecord()}>Refresh record</button>
							<div class="record-lines">
								{#each record as line, index (index)}
									<pre>{line}</pre>
								{/each}
							</div>
						</details>
					</div>

					<div class="dock">
						{#if transcript.status.state === "running"}
							<form
								class="compose steer"
								onsubmit={(event) => {
									event.preventDefault();
									void steer();
								}}
							>
								<div class="field grow">
									<label for="steer" class="sr-only">Steer</label>
									<input id="steer" bind:value={steerDraft} placeholder="say it differently, at the next gap" />
								</div>
								<button type="submit" class="btn">Steer</button>
							</form>
						{/if}
						<form
							class="compose"
							onsubmit={(event) => {
								event.preventDefault();
								void sendFollowUp();
							}}
						>
							<div class="field grow">
								<label for="question" class="sr-only">Ask Lyra</label>
								<input id="question" bind:value={draft} placeholder="say something else" />
							</div>
							<button type="submit" class="btn primary">Send</button>
						</form>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	:global(html) {
		color-scheme: light dark;
	}

	:global(body) {
		margin: 0;
	}

	.app {
		--bg: #f5f4f0;
		--surface: #ffffff;
		--sunken: #efede7;
		--ink: #1d1c1a;
		--dim: #6a675f;
		--line: #e2dfd7;
		--accent: #4f46c8;
		--accent-ink: #ffffff;
		--accent-wash: #eceafb;
		--attention: #a65a00;
		--attention-wash: #fff4de;
		--ok: #2a7a4b;
		--bad: #b3261e;
		--bad-wash: #fdecea;
		--busy: #1d63d6;
		--shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 4px 16px rgb(0 0 0 / 6%);
		--mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
		--sans: ui-sans-serif, "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;

		display: flex;
		flex-direction: column;
		height: 100vh;
		height: 100dvh;
		background: var(--bg);
		color: var(--ink);
		font: 0.95rem/1.55 var(--sans);
		overflow-wrap: anywhere;
	}

	@media (prefers-color-scheme: dark) {
		.app {
			--bg: #121211;
			--surface: #1b1b19;
			--sunken: #232321;
			--ink: #ece9e3;
			--dim: #9b978d;
			--line: #2d2c29;
			--accent: #928cf5;
			--accent-ink: #14132b;
			--accent-wash: #232141;
			--attention: #f0b45a;
			--attention-wash: #2b2214;
			--ok: #6cc590;
			--bad: #f08a82;
			--bad-wash: #321a18;
			--busy: #7aa7f5;
			--shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 4px 16px rgb(0 0 0 / 30%);
		}
	}

	.dim {
		color: var(--dim);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	/* The bar */

	.bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 1rem;
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		flex: none;
	}

	.brand {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
	}

	.mark {
		color: var(--accent);
	}

	.cap {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.78rem;
		color: var(--dim);
		min-width: 0;
	}

	.cap.over {
		color: var(--bad);
	}

	.meter {
		width: 4.5rem;
		height: 0.4rem;
		border-radius: 1rem;
		background: var(--sunken);
		overflow: hidden;
		flex: none;
	}

	.meter span {
		display: block;
		height: 100%;
		background: var(--accent);
	}

	.cap.over .meter span {
		background: var(--bad);
	}

	.banner {
		margin: 0;
		padding: 0.6rem 1rem;
		background: var(--bad-wash);
		color: var(--bad);
		border-bottom: 1px solid var(--bad);
		flex: none;
	}

	/* Controls */

	input,
	select {
		width: 100%;
		box-sizing: border-box;
		padding: 0.55rem 0.7rem;
		font: inherit;
		color: inherit;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 0.5rem;
	}

	input::placeholder {
		color: var(--dim);
	}

	input:focus-visible,
	select:focus-visible,
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.btn,
	.icon {
		font: inherit;
		font-weight: 600;
		padding: 0.5rem 0.95rem;
		border-radius: 0.5rem;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--ink);
		cursor: pointer;
		white-space: nowrap;
	}

	.btn:hover:not(:disabled) {
		background: var(--sunken);
	}

	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.btn.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}

	.btn.primary:hover:not(:disabled) {
		background: var(--accent);
		filter: brightness(1.08);
	}

	.btn.danger {
		color: var(--bad);
		border-color: var(--bad);
	}

	.btn.ghost {
		background: transparent;
		border-color: transparent;
		color: var(--dim);
		font-weight: 500;
	}

	.btn.wide {
		width: 100%;
	}

	.icon {
		display: none;
		padding: 0.3rem 0.65rem;
		font-size: 1.1rem;
	}

	.mini {
		font: inherit;
		font-size: 0.72rem;
		padding: 0.15rem 0.5rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: var(--surface);
		color: var(--dim);
		cursor: pointer;
	}

	label {
		display: block;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--dim);
		margin-bottom: 0.25rem;
	}

	/* Gate, loading and empty states */

	.center {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 1rem;
		overflow-y: auto;
	}

	.gate {
		width: min(26rem, 100%);
		display: grid;
		gap: 0.75rem;
		padding: 1.5rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 0.9rem;
		box-shadow: var(--shadow);
	}

	.gate h1,
	.hero h1 {
		font-size: 1.35rem;
		line-height: 1.25;
		letter-spacing: -0.01em;
	}

	.gate p {
		color: var(--dim);
	}

	.gate .fine {
		font-size: 0.78rem;
	}

	.empty {
		padding: 0.5rem 0;
		font-size: 0.85rem;
	}

	.hero {
		display: grid;
		gap: 0.6rem;
		max-width: 34rem;
		margin: 12vh auto 0;
		padding: 0 1rem;
	}

	.hero p {
		color: var(--dim);
	}

	/* The shell: rail and conversation */

	.shell {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 17.5rem minmax(0, 1fr);
	}

	.side {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.9rem;
		background: var(--surface);
		border-right: 1px solid var(--line);
		overflow-y: auto;
		min-height: 0;
	}

	.side h2 {
		margin-top: 0.4rem;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--dim);
	}

	.side ul {
		list-style: none;
		margin: 0;
		padding: 0;
		flex: 1;
		display: grid;
		gap: 0.15rem;
		align-content: start;
	}

	.entry {
		width: 100%;
		display: grid;
		gap: 0.05rem;
		text-align: left;
		font: inherit;
		padding: 0.5rem 0.65rem;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		color: var(--ink);
		cursor: pointer;
	}

	.entry:hover {
		background: var(--sunken);
	}

	.entry.selected {
		background: var(--accent-wash);
		box-shadow: inset 3px 0 0 var(--accent);
	}

	.entry-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.entry small {
		color: var(--dim);
		font-size: 0.74rem;
	}

	.scrim {
		display: none;
	}

	.convo {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.convo-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 1.25rem;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
		flex: none;
		flex-wrap: wrap;
	}

	.convo-title {
		flex: 1 1 10rem;
		min-width: 0;
	}

	.convo-title h2 {
		font-size: 1rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The status area: one place for what the run is doing */

	.status {
		display: inline-flex;
		align-items: baseline;
		gap: 0.45rem;
		padding: 0.25rem 0.7rem;
		border-radius: 2rem;
		font-size: 0.82rem;
		background: var(--sunken);
		--tone: var(--dim);
	}

	.status .hint {
		color: var(--dim);
		font-size: 0.78rem;
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--tone);
		align-self: center;
	}

	.status[data-tone="busy"] {
		--tone: var(--busy);
	}

	.status[data-tone="ok"] {
		--tone: var(--ok);
	}

	.status[data-tone="attention"] {
		--tone: var(--attention);
		background: var(--attention-wash);
	}

	.status[data-tone="bad"] {
		--tone: var(--bad);
		background: var(--bad-wash);
	}

	.status[data-tone="busy"] .dot {
		animation: pulse 1.2s ease-in-out infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.25;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.status[data-tone="busy"] .dot {
			animation: none;
		}
	}

	/* The transcript */

	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.25rem 1.5rem;
	}

	.transcript {
		list-style: none;
		margin: 0 auto;
		padding: 0;
		display: grid;
		gap: 0.9rem;
		max-width: 46rem;
	}

	.person {
		justify-self: end;
		max-width: 85%;
		padding: 0.55rem 0.85rem;
		background: var(--accent);
		color: var(--accent-ink);
		border-radius: 1rem 1rem 0.25rem 1rem;
	}

	.assistant {
		display: grid;
		gap: 0.4rem;
		max-width: 100%;
	}

	.assistant p {
		white-space: pre-wrap;
	}

	.thought summary,
	.more summary,
	.record summary {
		cursor: pointer;
		color: var(--dim);
		font-size: 0.8rem;
	}

	.thought p {
		margin-top: 0.3rem;
		padding-left: 0.8rem;
		border-left: 2px solid var(--line);
		color: var(--dim);
		font-style: italic;
		font-size: 0.88rem;
	}

	/* A call; consecutive calls read as one group (decision 154) */

	.tool {
		display: grid;
		gap: 0.4rem;
		padding: 0.55rem 0.8rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 0.6rem;
	}

	.tool + .tool {
		margin-top: -0.55rem;
		border-top-left-radius: 0;
		border-top-right-radius: 0;
	}

	.tool:has(+ .tool) {
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}

	.tool.error {
		border-color: var(--bad);
		background: var(--bad-wash);
	}

	.call {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
	}

	code {
		font-family: var(--mono);
		font-size: 0.85em;
	}

	.call code {
		font-weight: 700;
	}

	.chip {
		padding: 0.05rem 0.5rem;
		border-radius: 1rem;
		font-size: 0.72rem;
		background: var(--sunken);
		color: var(--dim);
	}

	.chip[data-state="running"] {
		color: var(--busy);
	}

	.chip[data-state="done"] {
		color: var(--ok);
	}

	.chip[data-state="failed"],
	.chip[data-state="error"] {
		color: var(--bad);
	}

	.duration {
		margin-left: auto;
		font-family: var(--mono);
		font-size: 0.75rem;
		color: var(--dim);
	}

	.state {
		color: var(--dim);
		font-size: 0.8rem;
	}

	pre {
		margin: 0;
		font-family: var(--mono);
		font-size: 0.76rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.more pre {
		margin-top: 0.3rem;
		padding: 0.5rem 0.65rem;
		background: var(--sunken);
		border-radius: 0.4rem;
		max-height: 10rem;
		overflow: auto;
	}

	.out {
		position: relative;
		padding: 0.5rem 0.65rem;
		background: var(--sunken);
		border-radius: 0.4rem;
	}

	.out pre {
		max-height: 12rem;
		overflow: auto;
		padding-right: 3rem;
	}

	.out .mini {
		position: absolute;
		top: 0.35rem;
		right: 0.35rem;
	}

	/* The cards: the one row that blocks the run, so the loudest thing on the page */

	.ask {
		display: grid;
		gap: 0.6rem;
		padding: 0.85rem 1rem;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 0.8rem;
	}

	.ask[data-open="true"] {
		background: var(--attention-wash);
		border: 2px solid var(--attention);
		box-shadow: var(--shadow);
	}

	.ask-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.badge {
		padding: 0.1rem 0.55rem;
		border-radius: 1rem;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		background: var(--attention);
		color: var(--bg);
	}

	.card-title {
		font-weight: 700;
	}

	.ask-body {
		white-space: pre-wrap;
	}

	.ask-meta {
		font-size: 0.8rem;
		color: var(--dim);
	}

	.ask-controls {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.ask-controls input {
		flex: 1 1 14rem;
		width: auto;
	}

	.choices {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.settled-state {
		text-transform: none;
	}

	.settled-state[data-state="denied"],
	.settled-state[data-state="rejected"],
	.settled-state[data-state="expired"] {
		color: var(--bad);
	}

	.settled-state[data-state="approved"],
	.settled-state[data-state="accepted"] {
		color: var(--ok);
	}

	.problem-row {
		padding: 0.5rem 0.8rem;
		border-radius: 0.5rem;
		background: var(--bad-wash);
		color: var(--bad);
	}

	/* The record panel */

	.record {
		max-width: 46rem;
		margin: 1.5rem auto 0;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--line);
	}

	.record-lines {
		margin-top: 0.4rem;
		max-height: 18rem;
		overflow: auto;
		padding: 0.5rem 0.65rem;
		background: var(--sunken);
		border-radius: 0.4rem;
		display: grid;
		gap: 0.3rem;
	}

	/* The dock: where a person speaks */

	.dock {
		flex: none;
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem calc(0.75rem + env(safe-area-inset-bottom));
		background: var(--bg);
		border-top: 1px solid var(--line);
	}

	.compose {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		width: min(46rem, 100%);
		margin: 0 auto;
		box-sizing: border-box;
	}

	.field {
		min-width: 0;
	}

	.field.grow {
		flex: 1;
	}

	.field.narrow {
		flex: 0 1 11rem;
	}

	.field.grow input {
		margin: 0;
	}

	/* A phone: the rail becomes a drawer, and nothing scrolls sideways */

	@media (max-width: 760px) {
		.icon {
			display: block;
		}

		.bar {
			padding: 0.5rem 0.75rem;
		}

		.cap-text {
			display: none;
		}

		.shell {
			grid-template-columns: minmax(0, 1fr);
			position: relative;
		}

		.side {
			position: absolute;
			z-index: 3;
			inset: 0 auto 0 0;
			width: min(20rem, 86vw);
			transform: translateX(-100%);
			transition: transform 0.18s ease;
			box-shadow: var(--shadow);
		}

		.shell.open .side {
			transform: none;
		}

		.scrim {
			display: block;
			position: absolute;
			z-index: 2;
			inset: 0;
			border: 0;
			background: rgb(0 0 0 / 40%);
		}

		.scroll,
		.convo-head,
		.dock {
			padding-left: 0.85rem;
			padding-right: 0.85rem;
		}

		.compose.new {
			flex-wrap: wrap;
		}

		.field.narrow {
			flex: 1 1 100%;
		}

		.person {
			max-width: 92%;
		}

		/* 16px stops iOS zooming the page when an input takes focus. */
		input,
		select {
			font-size: 1rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.side {
			transition: none;
		}
	}
</style>
