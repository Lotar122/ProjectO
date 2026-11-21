// Calls onGone once when the stream ends or closes. Used by main.js, with
// ARCHIVER_SUPERVISED=1, to notice that the web server (the other end of the
// stdin pipe) is gone.

import { fstatSync } from "node:fs";

/**
 * Whether a file descriptor is a pipe or socket, which is what the supervisor
 * passes as stdin. /dev/null, a TTY or a regular file is not: such a stdin
 * says nothing about the parent, and /dev/null would read as EOF at once.
 *
 * @param {number} [fd] Default 0 (stdin).
 * @returns {boolean} False also when fd cannot be inspected.
 */
export function isPipe(fd = 0)
{
	if (!Number.isSafeInteger(fd) || fd < 0)
	{
		throw new RangeError("fd must be a non-negative integer");
	}

	try
	{
		const stats = fstatSync(fd);

		return stats.isFIFO() || stats.isSocket();
	}
	catch
	{
		return false;
	}
}

/**
 * @param {import("node:stream").Readable} stdin Pipe from the supervising process.
 * @param {() => void} onGone Called at most once.
 * @returns {void}
 */
export function stopOnParentGone(stdin, onGone)
{
	if (typeof onGone !== "function")
	{
		throw new TypeError("onGone must be a function");
	}

	let called = false;
	const once = () =>
	{
		if (!called)
		{
			called = true;
			onGone();
		}
	};

	stdin.on("end", once);
	stdin.on("close", once);
	stdin.on("error", once);
	// A paused stream never emits "end"; the data itself is ignored.
	stdin.resume();
}
