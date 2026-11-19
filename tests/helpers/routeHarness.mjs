// Lets a test call an authenticated Next.js route handler directly, with no
// network, Postgres, Kratos or MinIO. Built on Bun's `mock.module`.
//
// Usage:
//
//   import { installRouteHarness, uninstallRouteHarness, harness, callRoute } from "./helpers/routeHarness.mjs";
//
//   await installRouteHarness();                 // once, before importing a route
//   beforeEach(() => harness.reset());           // clean state per test
//   afterAll(() => uninstallRouteHarness());     // real modules back for later files
//   const { PUT } = await import("../src/app/api/modifyOrder/route.js");
//
//   harness.session.loggedIn = true;
//   harness.session.userId = "user-1";
//   harness.db.queue([{ order_id: "..." }]);     // rows for the next query
//   const res = await callRoute(PUT, { method: "PUT", url: "/api/modifyOrder", body: formData });
//   harness.db.queries;                          // [{ text, strings, values, via, inTransaction }]
//   harness.db.transactions;                     // [{ outcome, queriesAtBegin, queriesAtEnd, s3CallsAtBegin, s3CallsAtEnd }]
//   harness.s3.calls;                            // commands sent to the stub S3
//
// Run under `bun test --conditions react-server` like the other tests; the
// routes import "server-only".

import { mock } from "bun:test";
import { createFakeS3 } from "./fakeS3.mjs";

const FRAGMENT = Symbol("fakeDbFragment");

const SOURCE_ROOT = new URL("../../src/", import.meta.url);

const resolveSource = (relativePath) => Bun.fileURLToPath(new URL(relativePath, SOURCE_ROOT));

function joinStrings(strings)
{
	return strings.join("?").replace(/\s+/g, " ").trim();
}

function createFakeDb(state)
{
	// Like postgres.js, a tagged template is lazy and thenable: awaiting it runs
	// the query, interpolating it into another template only splices its text
	// in. Nested fragments are flattened before the query is recorded.
	// `via` is the handle that built the fragment: "db" for the shared DB, "tx" for
	// the handle a `begin` callback receives.
	const createFragment = (strings, values, via = "db") =>
	{
		const fragment = {
			[FRAGMENT]: true,
			strings,
			values,
			via,
			then(onFulfilled, onRejected)
			{
				return execute(fragment).then(onFulfilled, onRejected);
			},
		};

		return fragment;
	};

	const flatten = (fragment) =>
	{
		const flatStrings = [];
		const flatValues = [];
		let pending = "";

		const walk = (current) =>
		{
			current.strings.forEach((chunk, index) =>
			{
				pending += chunk;

				if (index >= current.values.length)
				{
					return;
				}

				const value = current.values[index];

				if (value && value[FRAGMENT])
				{
					walk(value);
				}
				else
				{
					flatStrings.push(pending);
					pending = "";
					flatValues.push(value);
				}
			});
		};

		walk(fragment);
		flatStrings.push(pending);

		return { strings: flatStrings, values: flatValues };
	};

	const execute = async (fragment) =>
	{
		const { strings, values } = flatten(fragment);

		// `inTransaction` with `via: "db"` means the query bypassed an open transaction.
		state.queries.push({
			text: joinStrings(strings),
			strings,
			values,
			via: fragment.via,
			inTransaction: state.openTransactions > 0,
		});

		const next = state.queue.shift();

		if (next instanceof Error)
		{
			throw next;
		}

		return next ?? [];
	};

	const sql = (strings, ...values) => createFragment(strings, values);

	// Records where each transaction starts and ends, relative to the queries and
	// the S3 calls, so a test can check what ran inside it and what ran after the commit.
	// The callback gets its own handle, like postgres.js, so a query sent through the
	// outer DB while the transaction is open shows up in `outerQueriesInTransaction`.
	const tx = (strings, ...values) => createFragment(strings, values, "tx");

	tx.unsafe = (text) => createFragment([text], [], "tx");

	sql.begin = async (fn) =>
	{
		const transaction = {
			outcome: "pending",
			queriesAtBegin: state.queries.length,
			queriesAtEnd: null,
			s3CallsAtBegin: state.s3.calls.length,
			s3CallsAtEnd: null,
		};

		state.transactions.push(transaction);
		state.openTransactions += 1;

		try
		{
			const result = await fn(tx);

			transaction.outcome = "commit";

			return result;
		}
		catch (err)
		{
			transaction.outcome = "rollback";
			throw err;
		}
		finally
		{
			state.openTransactions -= 1;
			transaction.queriesAtEnd = state.queries.length;
			transaction.s3CallsAtEnd = state.s3.calls.length;
		}
	};
	sql.unsafe = (text) => createFragment([text], []);
	sql.end = async () =>
	{
	};

	return sql;
}

function createState()
{
	return {
		cookies: {},
		session: {
			loggedIn: false,
			userId: "test-user",
			role: undefined,
			data: undefined,
		},
		sessionError: null,
		queries: [],
		queue: [],
		transactions: [],
		openTransactions: 0,
		s3: createFakeS3(),
		authCalls: 0,
	};
}

const state = createState();
const fakeDb = createFakeDb(state);
const MOCKED_MODULES = [
	"next/headers",
	resolveSource("app/server-functions/getUserAuthSession.js"),
	resolveSource("app/lib/db.js"),
	resolveSource("app/server-functions/MinIO/createS3Client.js"),
];

// Real exports of the mocked modules while the harness is installed.
let originals = null;

function buildSession()
{
	if (!state.session.loggedIn)
	{
		return { loggedIn: false, data: null };
	}

	return {
		loggedIn: true,
		data: state.session.data ?? {
			active: true,
			identity: {
				id: state.session.userId,
				metadata_public: state.session.role === undefined ? {} : { role: state.session.role },
				traits: {},
			},
		},
	};
}

/**
 * Per-test configuration of the mocked collaborators. Mutate it directly or
 * through the helpers, and call `harness.reset()` between tests.
 */
export const harness = {
	/**
	 * Result of the mocked getUserAuthSession.
	 * @type {{ loggedIn: boolean, userId: string, role: string | undefined, data: object | undefined }}
	 */
	get session()
	{
		return state.session;
	},

	/** The fake S3 client (see fakeS3.mjs). */
	get s3()
	{
		return state.s3;
	},

	db: {
		/** Every query run so far: { text, strings, values }. `text` has `?` where a value goes. */
		get queries()
		{
			return state.queries;
		},

		/**
		 * Every `DB.begin` so far: { outcome: "commit" | "rollback" | "pending",
		 * queriesAtBegin, queriesAtEnd, s3CallsAtBegin, s3CallsAtEnd }. The counts are
		 * indexes into `queries` and `s3.calls`: entries in [atBegin, atEnd) ran inside it.
		 */
		get transactions()
		{
			return state.transactions;
		},

		/** Queries sent through the outer DB (not the transaction handle) while a transaction was open. */
		get outerQueriesInTransaction()
		{
			return state.queries.filter((query) => query.inTransaction && query.via === "db");
		},

		/**
		 * Queues the result of the next query. One call per query, consumed in
		 * order; an Error is thrown from that query instead of returned. Queries
		 * with nothing queued return an empty array.
		 *
		 * @param {...(object[] | Error)} results
		 */
		queue(...results)
		{
			state.queue.push(...results);
		},
	},

	/** Cookies the mocked `cookies()` jar holds, name -> value. */
	cookies: {
		/** @param {string} value */
		setSession(value = "test-session")
		{
			state.cookies.ory_kratos_session = value;
		},
	},

	/** Makes the mocked getUserAuthSession throw, like an unreachable Kratos. */
	failSession(err = new Error("Kratos whoami request failed"))
	{
		state.sessionError = err;
	},

	/** Number of times getUserAuthSession was called. */
	get authCalls()
	{
		return state.authCalls;
	},

	/** Back to: logged out, no cookies, no queries, empty S3. */
	reset()
	{
		const fresh = createState();

		state.cookies = fresh.cookies;
		state.session = fresh.session;
		state.sessionError = null;
		state.queries = fresh.queries;
		state.queue = fresh.queue;
		state.transactions = fresh.transactions;
		state.openTransactions = 0;
		state.authCalls = 0;
		state.s3.reset();
	},
};

/**
 * Registers the module mocks. Await it once per test file, before the first
 * import of a route module (use a dynamic `await import()` for the route).
 * Bun keeps module mocks for the whole process, so also call
 * `uninstallRouteHarness()` in `afterAll` to put the real modules back for
 * the test files that run after this one.
 *
 * @returns {Promise<void>}
 */
export async function installRouteHarness()
{
	if (originals)
	{
		return;
	}

	const captured = new Map();

	for (const specifier of MOCKED_MODULES)
	{
		captured.set(specifier, { ...(await import(specifier)) });
	}

	originals = captured;

	mock.module("next/headers", () => ({
		cookies: async () => ({
			get: (name) =>
			{
				return Object.hasOwn(state.cookies, name)
					? { name, value: state.cookies[name] }
					: undefined;
			},
			getAll: () => Object.entries(state.cookies).map(([name, value]) => ({ name, value })),
			has: (name) => Object.hasOwn(state.cookies, name),
		}),
		headers: async () => new Headers(),
	}));

	mock.module(resolveSource("app/server-functions/getUserAuthSession.js"), () => ({
		getUserAuthSession: async () =>
		{
			state.authCalls++;

			if (state.sessionError)
			{
				throw state.sessionError;
			}

			return buildSession();
		},
	}));

	mock.module(resolveSource("app/lib/db.js"), () => ({ DB: fakeDb }));

	mock.module(resolveSource("app/server-functions/MinIO/createS3Client.js"), () => ({
		createS3Client: async () => state.s3,
	}));
}

/** Puts the real modules back. Safe to call when the harness is not installed. */
export function uninstallRouteHarness()
{
	if (!originals)
	{
		return;
	}

	for (const [specifier, exports] of originals)
	{
		mock.module(specifier, () => exports);
	}

	originals = null;
}

/**
 * Calls a route handler with a Request built from the options.
 *
 * @param {(req: Request, context?: object) => Promise<Response>} handler
 * @param {object} [options]
 * @param {string} [options.method] Defaults to "GET".
 * @param {string} [options.url] Path or absolute URL. Defaults to "/".
 * @param {Record<string, string>} [options.headers] Extra headers. `sec-fetch-site: same-origin` is added unless overridden.
 * @param {BodyInit | object | null} [options.body] FormData, string, Blob etc. pass through; a plain object is sent as JSON.
 * @param {object} [options.context] Second argument for the handler (e.g. `{ params }`).
 * @returns {Promise<Response>}
 */
export async function callRoute(handler, { method = "GET", url = "/", headers = {}, body, context } = {})
{
	if (typeof handler !== "function")
	{
		throw new TypeError("callRoute expects a route handler function");
	}

	const requestHeaders = new Headers({ "sec-fetch-site": "same-origin" });

	for (const [name, value] of Object.entries(headers))
	{
		requestHeaders.set(name, value);
	}

	let requestBody = body;

	const isPlainObject = body !== null && typeof body === "object" && Object.getPrototypeOf(body) === Object.prototype;

	if (isPlainObject)
	{
		requestBody = JSON.stringify(body);

		if (!requestHeaders.has("content-type"))
		{
			requestHeaders.set("content-type", "application/json");
		}
	}

	const request = new Request(new URL(url, "http://localhost").href, {
		method,
		headers: requestHeaders,
		body: requestBody ?? undefined,
	});

	return handler(request, context);
}
