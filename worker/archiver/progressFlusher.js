// Writes a job's progress to the database on a timer, only when it changed.
// Writes never overlap: each one waits for the previous, and reads the
// progress when it runs, so a burst of flush() calls collapses into one write.

/**
 * @param {object} options
 * @param {() => object} options.read Returns the current progress (JSON-serializable).
 * @param {(progress: object) => Promise<unknown>} options.write Stores a snapshot.
 * @param {number} options.intervalMs Timer period.
 * @param {(err: unknown) => void} [options.onError] A failed write is retried on the next flush.
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer] For tests; default setInterval.
 * @param {(handle: unknown) => void} [options.clearTimer] For tests; default clearInterval.
 * @returns {{ start: () => void, flush: () => Promise<boolean>, stop: () => Promise<boolean> }}
 *   flush resolves to true when it wrote. stop clears the timer and resolves
 *   once the writes already queued have finished (it adds none: the caller's
 *   final write, finishJob, stores the last progress).
 */
export function createProgressFlusher({
	read,
	write,
	intervalMs,
	onError,
	setTimer = setInterval,
	clearTimer = clearInterval,
})
{
	if (typeof read !== "function" || typeof write !== "function")
	{
		throw new TypeError("read and write must be functions");
	}

	if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
	{
		throw new RangeError("intervalMs must be a positive integer");
	}

	let lastWritten = null;
	let chain = Promise.resolve(false);
	let timer = null;

	const writeIfChanged = async () =>
	{
		const json = JSON.stringify(read());

		if (json === lastWritten)
		{
			return false;
		}

		await write(JSON.parse(json));
		lastWritten = json;

		return true;
	};

	const flush = () =>
	{
		chain = chain.then(writeIfChanged).catch((err) =>
		{
			onError?.(err);
			return false;
		});

		return chain;
	};

	return {
		start()
		{
			if (timer === null)
			{
				timer = setTimer(() =>
				{
					flush();
				}, intervalMs);
				timer?.unref?.();
			}
		},

		flush,

		stop()
		{
			if (timer !== null)
			{
				clearTimer(timer);
				timer = null;
			}

			return chain;
		},
	};
}
