export const ACTIVE_POLL_INTERVAL_MS = 3000;
export const IDLE_POLL_INTERVAL_MS = 20000;

/**
 * Polling loop for the archiver status. Requests never overlap: the next poll is scheduled
 * only after the previous one settles, and a refresh asked for while one is in flight runs
 * once more afterwards. Polls pause while the tab is hidden and resume when it is shown.
 * Everything that touches the outside world is injected so the loop can be tested.
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<unknown>} options.fetchStatus Sends one status request.
 * @param {(data: unknown) => void} options.onData Called with a fresh, non-stale response.
 * @param {(err: unknown) => void} options.onError Called when a request fails and was not aborted.
 * @param {() => void} [options.onSettled] Called after every request that was not aborted.
 * @param {() => boolean} options.isActive True while a job is queued, running or stalled.
 * @param {AbortSignal} options.signal Aborting it stops the loop for good.
 * @param {{ isHidden: () => boolean, subscribe: (listener: () => void) => () => void }} options.visibility
 * @param {{ set: (callback: () => void, ms: number) => unknown, clear: (handle: unknown) => void }} options.timers
 * @param {number} [options.activeIntervalMs] Poll interval while a job is active.
 * @param {number} [options.idleIntervalMs] Poll interval while no job is active.
 * @returns {{ refresh: () => void, schedule: () => void, beginMutation: () => void, endMutation: () => void }}
 * `beginMutation` and `endMutation` bracket a request that changes the status (the start
 * request): a status request sent before it finished is stale and its response is dropped.
 */
export function createStatusPoller(options)
{
	const {
		fetchStatus,
		onData,
		onError,
		onSettled = () => undefined,
		isActive,
		signal,
		visibility,
		timers,
		activeIntervalMs = ACTIVE_POLL_INTERVAL_MS,
		idleIntervalMs = IDLE_POLL_INTERVAL_MS,
	} = options ?? {};

	for (const [name, value] of Object.entries({ fetchStatus, onData, onError, isActive }))
	{
		if (typeof value !== "function")
		{
			throw new TypeError(`${name} must be a function`);
		}
	}

	if (!(signal instanceof AbortSignal))
	{
		throw new TypeError("signal must be an AbortSignal");
	}

	if (typeof visibility?.isHidden !== "function" || typeof visibility?.subscribe !== "function")
	{
		throw new TypeError("visibility must have isHidden and subscribe");
	}

	if (typeof timers?.set !== "function" || typeof timers?.clear !== "function")
	{
		throw new TypeError("timers must have set and clear");
	}

	let timer = null;
	let inFlight = false;
	let dirty = false;
	let epoch = 0;

	const clearTimer = () =>
	{
		if (timer !== null)
		{
			timers.clear(timer);
			timer = null;
		}
	};

	const schedule = () =>
	{
		clearTimer();

		if (signal.aborted || inFlight || visibility.isHidden())
		{
			return;
		}

		timer = timers.set(() =>
		{
			timer = null;

			if (!visibility.isHidden())
			{
				run();
			}
		}, isActive() ? activeIntervalMs : idleIntervalMs);
	};

	const run = async () =>
	{
		if (signal.aborted)
		{
			return;
		}

		if (inFlight)
		{
			dirty = true;

			return;
		}

		clearTimer();
		inFlight = true;

		const requestEpoch = epoch;

		try
		{
			const data = await fetchStatus(signal);

			if (!signal.aborted && requestEpoch === epoch)
			{
				onData(data);
			}
		}
		catch (err)
		{
			if (!signal.aborted)
			{
				onError(err);
			}
		}
		finally
		{
			inFlight = false;

			if (!signal.aborted)
			{
				onSettled();
			}
		}

		if (dirty && !signal.aborted)
		{
			dirty = false;
			run();

			return;
		}

		schedule();
	};

	const unsubscribe = visibility.subscribe(() =>
	{
		if (!visibility.isHidden())
		{
			run();
		}
	});

	signal.addEventListener("abort", () =>
	{
		clearTimer();
		unsubscribe();
	}, { once: true });

	run();

	return {
		refresh: run,
		schedule,
		beginMutation: () =>
		{
			epoch++;
		},
		endMutation: () =>
		{
			epoch++;
		},
	};
}
