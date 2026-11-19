import test from "node:test";
import assert from "node:assert/strict";
import http, {
	combineSignals,
	disposeSignal,
	isAbortError,
	timeoutSignal,
} from "../src/app/lib/http.js";

// Hides a static AbortSignal method while fn runs, awaiting it when async.
const withoutStatic = async (name, fn) =>
{
	const original = Object.getOwnPropertyDescriptor(AbortSignal, name);
	AbortSignal[name] = undefined;
	try
	{
		return await fn();
	}
	finally
	{
		Object.defineProperty(AbortSignal, name, original);
	}
};

const reason = (name) => new DOMException("reason", name);

// Counts the abort listeners a signal currently holds.
function trackListeners(signal)
{
	const counts = { active: 0 };
	const originalAdd = signal.addEventListener.bind(signal);
	const originalRemove = signal.removeEventListener.bind(signal);

	signal.addEventListener = (type, listener, options) =>
	{
		counts.active++;
		originalAdd(type, listener, options);
	};
	signal.removeEventListener = (type, listener, options) =>
	{
		counts.active--;
		originalRemove(type, listener, options);
	};

	return counts;
}

test("combineSignals falls back when AbortSignal.any is missing", async () =>
{
	await withoutStatic("any", () =>
	{
		const a = new AbortController();
		const b = new AbortController();
		const combined = combineSignals([a.signal, b.signal]);

		assert.equal(combined.aborted, false);
		a.abort(reason("AbortError"));
		assert.equal(combined.aborted, true);
		assert.equal(combined.reason.name, "AbortError");
	});
});

test("combineSignals aborts when the second input aborts, keeping its reason", async () =>
{
	await withoutStatic("any", () =>
	{
		const a = new AbortController();
		const b = new AbortController();
		const combined = combineSignals([a.signal, b.signal]);

		b.abort(reason("TimeoutError"));
		assert.equal(combined.aborted, true);
		assert.equal(combined.reason.name, "TimeoutError");
		assert.equal(isAbortError(combined.reason), true);
	});
});

test("combineSignals removes its listeners after aborting", async () =>
{
	await withoutStatic("any", () =>
	{
		const a = new AbortController();
		const b = new AbortController();
		const removed = [];
		const originalRemove = a.signal.removeEventListener.bind(a.signal);
		a.signal.removeEventListener = (type, listener, options) =>
		{
			removed.push(type);
			originalRemove(type, listener, options);
		};

		combineSignals([a.signal, b.signal]);
		a.abort(reason("AbortError"));
		assert.deepEqual(removed, ["abort"]);
	});
});

test("disposeSignal removes the fallback listeners from inputs that never abort", async () =>
{
	await withoutStatic("any", () =>
	{
		const a = new AbortController();
		const b = new AbortController();
		const onA = trackListeners(a.signal);
		const onB = trackListeners(b.signal);
		const combined = combineSignals([a.signal, b.signal]);

		assert.equal(onA.active, 1);
		assert.equal(onB.active, 1);

		disposeSignal(combined);
		assert.equal(onA.active, 0);
		assert.equal(onB.active, 0);

		// Idempotent, and the combined signal no longer follows its inputs.
		disposeSignal(combined);
		a.abort(reason("AbortError"));
		assert.equal(combined.aborted, false);
	});
});

test("disposeSignal ignores signals that hold nothing", () =>
{
	disposeSignal(new AbortController().signal);
	disposeSignal(AbortSignal.timeout(60000));
});

test("combineSignals returns an already-aborted signal when an input is aborted", async () =>
{
	await withoutStatic("any", () =>
	{
		const a = new AbortController();
		const b = new AbortController();
		b.abort(reason("AbortError"));

		const combined = combineSignals([a.signal, b.signal]);
		assert.equal(combined.aborted, true);
		assert.equal(combined.reason.name, "AbortError");
	});
});

test("combineSignals with no inputs stays pending", async () =>
{
	await withoutStatic("any", () =>
	{
		assert.equal(combineSignals([]).aborted, false);
	});
});

test("combineSignals uses AbortSignal.any when available", () =>
{
	const a = new AbortController();
	const combined = combineSignals([a.signal]);

	a.abort(reason("AbortError"));
	assert.equal(combined.aborted, true);
	assert.equal(combined.reason.name, "AbortError");
});

test("timeoutSignal falls back to a TimeoutError when AbortSignal.timeout is missing", async () =>
{
	await withoutStatic("timeout", async () =>
	{
		const signal = timeoutSignal(5);
		assert.equal(signal.aborted, false);

		await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		assert.equal(signal.reason.name, "TimeoutError");
		assert.equal(isAbortError(signal.reason), true);
	});
});

test("disposeSignal cancels the fallback timeout timer", async () =>
{
	await withoutStatic("timeout", async () =>
	{
		const signal = timeoutSignal(5);

		disposeSignal(signal);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(signal.aborted, false);
	});
});

test("timeoutSignal fallback can be combined with a caller signal", async () =>
{
	await withoutStatic("timeout", () => withoutStatic("any", () =>
	{
		assert.equal(AbortSignal.any, undefined);
		assert.equal(AbortSignal.timeout, undefined);

		const caller = new AbortController();
		const combined = combineSignals([timeoutSignal(1000), caller.signal]);

		assert.equal(combined.aborted, false);
		caller.abort(reason("AbortError"));
		assert.equal(combined.aborted, true);
		assert.equal(combined.reason.name, "AbortError");
		disposeSignal(combined);
	}));
});

test("withoutStatic restores the static after an async callback", async () =>
{
	const original = AbortSignal.any;

	await withoutStatic("any", async () =>
	{
		await Promise.resolve();
		assert.equal(AbortSignal.any, undefined);
	});
	assert.equal(AbortSignal.any, original);
});

test("request releases fallback listeners and timer once the response is read", async () =>
{
	const realFetch = globalThis.fetch;
	const realClearTimeout = globalThis.clearTimeout;
	const cleared = [];

	globalThis.fetch = async () => Response.json({ ok: true });
	globalThis.clearTimeout = (timer) =>
	{
		cleared.push(timer);
		realClearTimeout(timer);
	};

	try
	{
		await withoutStatic("timeout", () => withoutStatic("any", async () =>
		{
			const caller = new AbortController();
			const listeners = trackListeners(caller.signal);
			const result = await http.get("/x", { signal: caller.signal });

			assert.deepEqual(result.data, { ok: true });
			assert.equal(listeners.active, 0);
			assert.equal(cleared.length, 1);
		}));
	}
	finally
	{
		globalThis.fetch = realFetch;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test("request releases fallback listeners when the server answers with an error", async () =>
{
	const realFetch = globalThis.fetch;

	globalThis.fetch = async () => Response.json({ error: "no" }, { status: 500 });

	try
	{
		await withoutStatic("any", async () =>
		{
			const caller = new AbortController();
			const listeners = trackListeners(caller.signal);

			await assert.rejects(http.get("/x", { signal: caller.signal }), { name: "HttpError" });
			assert.equal(listeners.active, 0);
		});
	}
	finally
	{
		globalThis.fetch = realFetch;
	}
});
