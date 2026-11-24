/**
 * The streaming line reader (docs/protocol.md, FRM01 and FRM03).
 *
 * Bytes arrive in whatever pieces the network hands over, and frames are lines,
 * so this turns one into the other: split on `\n` only, accept `\r\n`, skip empty
 * lines, and decode UTF-8 across a chunk boundary rather than per chunk. A line
 * longer than the cap ends the connection, as in Nova's protocol, because a line
 * that big is not a frame anybody meant to send.
 *
 * Splitting on bytes rather than on decoded text is what makes a multi-byte
 * character that straddles two chunks come out right: `\n` can never be part of a
 * UTF-8 sequence, so every line's bytes decode on their own.
 */

/** A record entry is capped at 1 MiB (decision 90), so a frame carrying one fits twice over. */
export const DEFAULT_LINE_CAP_BYTES = 2 * 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface LineReaderOptions {
	/** How many bytes one line may take, newline excluded. */
	maxLineBytes?: number;
}

export interface LineRead {
	/** Every complete line, in order, with `\r\n` and the newline removed. */
	lines: string[];
	/** Set when a line passed the cap: the connection is closed and nothing more is read. */
	overCap?: { bytes: number; cap: number };
}

export interface LineReader {
	push(chunk: Uint8Array): LineRead;
	/** The bytes of a line that never got its newline, if any. */
	end(): LineRead;
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** The pieces of one line as one run of bytes, copying only when there is more than one piece. */
function joined(pieces: readonly Uint8Array[], length: number): Uint8Array {
	if (pieces.length === 1) {
		return pieces[0] as Uint8Array;
	}
	const whole = new Uint8Array(length);
	let at = 0;
	for (const piece of pieces) {
		whole.set(piece, at);
		at += piece.length;
	}
	return whole;
}

export function lineReader(options: LineReaderOptions = {}): LineReader {
	const cap = options.maxLineBytes ?? DEFAULT_LINE_CAP_BYTES;
	/**
	 * The start of the line being assembled, as the pieces that have arrived so far.
	 * They are copies, because a caller may reuse the chunk it handed in, and they
	 * are kept as bytes rather than one number each, so a line near the cap costs
	 * about its own size and not eight times it.
	 */
	let pending: Uint8Array[] = [];
	let pendingLength = 0;
	let overCap: { bytes: number; cap: number } | undefined;

	/** One line's bytes as text, without its `\r`; empty text is the keep-alive between frames. */
	const lineOf = (bytes: Uint8Array): string =>
		decode(
			bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN
				? bytes.subarray(0, -1)
				: bytes,
		);

	return {
		push(chunk) {
			if (overCap !== undefined) {
				return { lines: [], overCap };
			}
			const lines: string[] = [];
			let start = 0;
			for (;;) {
				const newline = chunk.indexOf(NEWLINE, start);
				const end = newline === -1 ? chunk.length : newline;
				// The first byte past the cap is where the line is refused, whether or not its
				// newline has arrived yet, and the report names that byte's position.
				if (pendingLength + (end - start) > cap) {
					overCap = { bytes: cap + 1, cap };
					pending = [];
					pendingLength = 0;
					return { lines, overCap };
				}
				if (newline === -1) {
					if (end > start) {
						pending.push(chunk.slice(start, end));
						pendingLength += end - start;
					}
					return { lines };
				}
				const pieces =
					pending.length === 0
						? [chunk.subarray(start, end)]
						: [...pending, chunk.subarray(start, end)];
				const line = lineOf(joined(pieces, pendingLength + (end - start)));
				pending = [];
				pendingLength = 0;
				if (line !== "") {
					lines.push(line);
				}
				start = newline + 1;
			}
		},

		end() {
			if (overCap !== undefined) {
				return { lines: [], overCap };
			}
			if (pendingLength === 0) {
				return { lines: [] };
			}
			const line = lineOf(joined(pending, pendingLength));
			pending = [];
			pendingLength = 0;
			return { lines: line === "" ? [] : [line] };
		},
	};
}
