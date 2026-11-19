// Runs fn over items with at most `limit` calls in flight, keeping result order.
export async function mapWithConcurrency(items, limit, fn)
{
	const results = new Array(items.length);
	let nextIndex = 0;

	const worker = async () =>
	{
		while (nextIndex < items.length)
		{
			const index = nextIndex++;
			results[index] = await fn(items[index]);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

	return results;
}

export class SemaphoreTimeoutError extends Error
{
	constructor(timeoutMs)
	{
		super(`No capacity became available within ${timeoutMs} ms`);
		this.name = "SemaphoreTimeoutError";
		this.code = "SEMAPHORE_TIMEOUT";
	}
}

/**
 * A FIFO semaphore whose permits have a weight, for sharing a memory budget.
 * A waiter is served in arrival order, so a large request is never starved by
 * a stream of small ones.
 *
 * @param {number} capacity Total weight that may be held at once (> 0).
 * @returns {{
 *   acquire: (weight: number, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<() => boolean>,
 *   readonly capacity: number,
 *   readonly available: number,
 *   readonly waiting: number,
 * }}
 */
export function createWeightedSemaphore(capacity)
{
	if (!Number.isFinite(capacity) || capacity <= 0)
	{
		throw new RangeError("capacity must be a positive finite number");
	}

	let available = capacity;
	const waiters = [];

	// Hands out capacity to waiters from the front of the queue, in order.
	const drain = () =>
	{
		while (waiters.length > 0 && waiters[0].weight <= available)
		{
			const waiter = waiters.shift();

			available -= waiter.weight;
			waiter.grant();
		}
	};

	// The returned function gives the weight back the first time it is called and
	// does nothing afterwards, so every close/error/abort path may call it.
	// It returns true only for the call that actually released.
	const createRelease = (weight) =>
	{
		let released = false;

		return () =>
		{
			if (released)
			{
				return false;
			}

			released = true;
			available += weight;
			drain();

			return true;
		};
	};

	return {
		get capacity()
		{
			return capacity;
		},

		get available()
		{
			return available;
		},

		get waiting()
		{
			return waiters.length;
		},

		/**
		 * Waits for `weight` of the capacity and resolves to its release function.
		 * A weight above the capacity is clamped to it, so such a request waits for
		 * an empty semaphore instead of forever.
		 *
		 * Rejects with the signal's reason when `signal` aborts first, and with
		 * SemaphoreTimeoutError after `timeoutMs`. A rejected acquire holds nothing.
		 *
		 * @param {number} weight Weight to hold (> 0).
		 * @param {object} [options]
		 * @param {AbortSignal} [options.signal]
		 * @param {number} [options.timeoutMs] No limit when omitted.
		 * @returns {Promise<() => boolean>}
		 */
		acquire(weight, { signal, timeoutMs } = {})
		{
			if (!Number.isFinite(weight) || weight <= 0)
			{
				throw new RangeError("weight must be a positive finite number");
			}

			const held = Math.min(weight, capacity);

			if (signal?.aborted)
			{
				return Promise.reject(signal.reason);
			}

			if (waiters.length === 0 && held <= available)
			{
				available -= held;

				return Promise.resolve(createRelease(held));
			}

			return new Promise((resolve, reject) =>
			{
				let timer;

				const waiter = {
					weight: held,
					grant()
					{
						cleanup();
						resolve(createRelease(held));
					},
				};

				const leaveQueue = (error) =>
				{
					const index = waiters.indexOf(waiter);

					if (index !== -1)
					{
						waiters.splice(index, 1);
						cleanup();
						reject(error);
						// The waiter in front may have been the one blocking the rest.
						drain();
					}
				};
				const onAbort = () => leaveQueue(signal.reason);

				function cleanup()
				{
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				}

				if (timeoutMs !== undefined)
				{
					timer = setTimeout(() => leaveQueue(new SemaphoreTimeoutError(timeoutMs)), timeoutMs);
				}

				signal?.addEventListener("abort", onAbort, { once: true });
				waiters.push(waiter);
			});
		},
	};
}
