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

export function lineReader(options: LineReaderOptions = {}): LineReader {
	const cap = options.maxLineBytes ?? DEFAULT_LINE_CAP_BYTES;
	/** Bytes of the line being assembled, which always ends at a newline. */
	let pending: number[] = [];
	let overCap: { bytes: number; cap: number } | undefined;

	const lineOf = (bytes: readonly number[]): string => {
		const withoutCarriageReturn =
			bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN
				? bytes.slice(0, -1)
				: bytes;
		const text = decode(Uint8Array.from(withoutCarriageReturn));
		// An empty line is the keep-alive a stream sends between frames.
		return text === "" ? "" : text;
	};

	return {
		push(chunk) {
			if (overCap !== undefined) {
				return { lines: [], overCap };
			}
			const lines: string[] = [];
			for (const byte of chunk) {
				if (byte === NEWLINE) {
					const line = lineOf(pending);
					pending = [];
					if (line !== "") {
						lines.push(line);
					}
					continue;
				}
				pending.push(byte);
				if (pending.length > cap) {
					overCap = { bytes: pending.length, cap };
					pending = [];
					return { lines, overCap };
				}
			}
			return { lines };
		},

		end() {
			if (overCap !== undefined) {
				return { lines: [], overCap };
			}
			if (pending.length === 0) {
				return { lines: [] };
			}
			const line = lineOf(pending);
			pending = [];
			return { lines: line === "" ? [] : [line] };
		},
	};
}
