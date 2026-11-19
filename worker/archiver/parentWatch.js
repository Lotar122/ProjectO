// Calls onGone once when the stream ends or closes. Used by main.js, with
// ARCHIVER_SUPERVISED=1, to notice that the web server (the other end of the
// stdin pipe) is gone.

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
