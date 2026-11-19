import test from "node:test";
import assert from "node:assert/strict";
import {
	ACTIVE_POLL_INTERVAL_MS,
	IDLE_POLL_INTERVAL_MS,
	createStatusPoller,
} from "../src/app/admin/components/archiverPolling.js";

// Lets pending promise callbacks run.
const flush = async () =>
{
	for (let i = 0; i < 5; i++)
	{
		await Promise.resolve();
	}
};

function createHarness({ active = false, hidden = false } = {})
{
	const controller = new AbortController();
	const state = { active, hidden };
	const requests = [];
	const received = [];
	const errors = [];
	const listeners = new Set();
	const timers = [];
	let nextTimerId = 1;

	const poller = createStatusPoller({
		fetchStatus: (signal) =>
		{
			const request = { signal };

			request.promise = new Promise((resolve, reject) =>
			{
				request.resolve = resolve;
				request.reject = reject;
			});
			requests.push(request);

			return request.promise;
		},
		onData: (data) => received.push(data),
		onError: (err) => errors.push(err),
		isActive: () => state.active,
		signal: controller.signal,
		visibility: {
			isHidden: () => state.hidden,
			subscribe: (listener) =>
			{
				listeners.add(listener);

				return () => listeners.delete(listener);
			},
		},
		timers: {
			set: (callback, ms) =>
			{
				const timer = { id: nextTimerId++, callback, ms };

				timers.push(timer);

				return timer.id;
			},
			clear: (id) =>
			{
				const index = timers.findIndex((timer) => timer.id === id);

				if (index !== -1)
				{
					timers.splice(index, 1);
				}
			},
		},
	});

	return {
		poller,
		controller,
		state,
		requests,
		received,
		errors,
		timers,
		listeners,
		setHidden: (hidden) =>
		{
			state.hidden = hidden;

			for (const listener of [...listeners])
			{
				listener();
			}
		},
		// Runs the pending timer, as if its delay had passed.
		fire: () =>
		{
			const timer = timers.shift();

			timer.callback();
		},
		respond: async (index, data) =>
		{
			requests[index].resolve(data);
			await flush();
		},
	};
}

test("the first request is sent at once and its data is applied", async () =>
{
	const h = createHarness();

	assert.equal(h.requests.length, 1);

	await h.respond(0, { state: "idle" });

	assert.deepEqual(h.received, [{ state: "idle" }]);
});

test("requests never overlap: a refresh during a request runs once after it settles", async () =>
{
	const h = createHarness();

	h.poller.refresh();
	h.poller.refresh();
	h.poller.refresh();
	assert.equal(h.requests.length, 1);

	await h.respond(0, "a");
	// One extra GET, not three, and it starts only after the first one settled.
	assert.equal(h.requests.length, 2);

	await h.respond(1, "b");
	assert.equal(h.requests.length, 2);
	assert.deepEqual(h.received, ["a", "b"]);
});

test("the next poll is scheduled only after the request settles", async () =>
{
	const h = createHarness({ active: true });

	assert.equal(h.timers.length, 0);

	await h.respond(0, "a");
	assert.equal(h.timers.length, 1);
	assert.equal(h.timers[0].ms, ACTIVE_POLL_INTERVAL_MS);

	h.fire();
	assert.equal(h.requests.length, 2);
	assert.equal(h.timers.length, 0);
});

test("a failed request reports the error and polling continues", async () =>
{
	const h = createHarness({ active: true });

	h.requests[0].reject(new Error("boom"));
	await flush();

	assert.equal(h.errors.length, 1);
	assert.equal(h.timers.length, 1);
});

test("the interval switches between active and idle with the state", async () =>
{
	const h = createHarness({ active: true });

	await h.respond(0, "running");
	assert.equal(h.timers[0].ms, ACTIVE_POLL_INTERVAL_MS);

	h.state.active = false;
	h.fire();
	await h.respond(1, "done");
	assert.equal(h.timers[0].ms, IDLE_POLL_INTERVAL_MS);
	assert.equal(IDLE_POLL_INTERVAL_MS, 20000);

	h.state.active = true;
	h.fire();
	await h.respond(2, "queued");
	assert.equal(h.timers[0].ms, ACTIVE_POLL_INTERVAL_MS);
});

test("a hidden tab sends no timed poll and a visible one polls again at once", async () =>
{
	const h = createHarness({ active: true });

	await h.respond(0, "running");
	assert.equal(h.timers.length, 1);

	h.setHidden(true);
	// The timer was already set; when it fires in a hidden tab it must not send a request.
	h.fire();
	assert.equal(h.requests.length, 1);
	assert.equal(h.timers.length, 0);

	h.setHidden(false);
	assert.equal(h.requests.length, 2);
	await h.respond(1, "running");
	assert.equal(h.timers.length, 1);
});

test("a tab that is hidden when a request settles schedules nothing", async () =>
{
	const h = createHarness({ active: false });

	h.setHidden(true);
	await h.respond(0, "idle");

	assert.equal(h.timers.length, 0);
});

test("a visible idle tab keeps polling slowly", async () =>
{
	const h = createHarness({ active: false });

	await h.respond(0, "idle");
	assert.equal(h.timers.length, 1);
	assert.equal(h.timers[0].ms, IDLE_POLL_INTERVAL_MS);
});

test("aborting stops the loop: timer cleared, listener removed, late data ignored", async () =>
{
	const h = createHarness({ active: true });

	await h.respond(0, "running");
	assert.equal(h.timers.length, 1);

	h.fire();
	assert.equal(h.requests.length, 2);

	h.controller.abort();
	assert.equal(h.timers.length, 0);
	assert.equal(h.listeners.size, 0);
	assert.equal(h.requests[1].signal.aborted, true);

	await h.respond(1, "late");
	assert.deepEqual(h.received, ["running"]);
	assert.equal(h.timers.length, 0);

	h.poller.refresh();
	assert.equal(h.requests.length, 2);
});

test("an error after abort is not reported", async () =>
{
	const h = createHarness();

	h.controller.abort();
	h.requests[0].reject(new DOMException("Aborted", "AbortError"));
	await flush();

	assert.deepEqual(h.errors, []);
});

test("epoch guard: a status request sent before a mutation finished is dropped", async () =>
{
	const h = createHarness({ active: true });

	// Request 0 is in flight (the first load) when the start request begins.
	h.poller.beginMutation();
	h.poller.endMutation();

	await h.respond(0, "stale");
	assert.deepEqual(h.received, []);
});

test("epoch guard: a request that started during the mutation is dropped too", async () =>
{
	const h = createHarness();

	await h.respond(0, "first");
	h.poller.beginMutation();
	h.poller.refresh();
	h.poller.endMutation();

	await h.respond(1, "during");
	assert.deepEqual(h.received, ["first"]);

	h.poller.refresh();
	await h.respond(2, "after");
	assert.deepEqual(h.received, ["first", "after"]);
});

test("dirty flag: a refresh asked for after a mutation is not lost behind a stale request", async () =>
{
	const h = createHarness();

	h.poller.beginMutation();
	h.poller.endMutation();
	// The start returned no status, so the panel asks for one while the stale GET is still in flight.
	h.poller.refresh();
	assert.equal(h.requests.length, 1);

	await h.respond(0, "stale");
	assert.deepEqual(h.received, []);
	assert.equal(h.requests.length, 2);

	await h.respond(1, "fresh");
	assert.deepEqual(h.received, ["fresh"]);
});

test("invalid options are rejected", () =>
{
	assert.throws(() => createStatusPoller(), TypeError);
	assert.throws(() => createStatusPoller({}), TypeError);
});
