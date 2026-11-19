// In-memory stand-in for an S3Client. It records every command passed to
// `send()`, keeps an object store, and lets a test decide when an upload
// lands, so races between a failure and a slow PutObject can be reproduced
// without timing luck or a network.
//
// Works with @aws-sdk/lib-storage's `Upload` (the stub exposes the few
// `client.config` members it reads) and with plain `s3.send(new XCommand())`.

const GATED_TYPES = new Set(["PutObject", "UploadPart", "CompleteMultipartUpload"]);

function toBuffer(body)
{
	if (body === undefined || body === null)
	{
		return Buffer.alloc(0);
	}

	if (typeof body === "string")
	{
		return Buffer.from(body);
	}

	if (body instanceof Uint8Array)
	{
		return Buffer.from(body);
	}

	return null;
}

function s3Error(name, statusCode, message = name)
{
	return Object.assign(new Error(message), {
		name,
		$metadata: { httpStatusCode: statusCode },
	});
}

function createMatcher(match)
{
	if (match === undefined || match === "*")
	{
		return () => true;
	}

	if (typeof match === "function")
	{
		return match;
	}

	if (typeof match === "string")
	{
		return (key) => key === match;
	}

	throw new TypeError("gate() expects a key, a predicate or nothing");
}

/**
 * @typedef {object} FakeS3Gate
 * @property {() => void} release Lets every held (and future) matching command complete.
 * @property {(err: Error) => void} fail Makes every held (and future) matching command reject with `err`.
 */

/**
 * @typedef {object} FakeS3Call
 * @property {string} type Command name without the "Command" suffix, e.g. "PutObject".
 * @property {string | undefined} key Object key the command targets.
 * @property {Record<string, any>} input The command input.
 */

/**
 * Creates the stub client.
 *
 * Fields on the result:
 * - `send(command)`: the S3Client method.
 * - `calls`: every command in the order it was sent.
 * - `started`: keys of PutObject / CreateMultipartUpload calls, in order.
 * - `objects`: Map of key -> { body, metadata, etag }.
 * - `deleted`: keys removed through DeleteObjects.
 * - `callsOf(type)`: calls of one command type.
 * - `gate(match)`: hold PutObject / UploadPart / CompleteMultipartUpload for matching keys.
 * - `seed(key, { body, metadata })`: put an object in the store without a call.
 * - `waitForStarted(count)`: resolves once `count` uploads have started.
 * - `settled()`: resolves once every send issued so far has finished.
 *
 * @returns {object}
 */
export function createFakeS3()
{
	const calls = [];
	const started = [];
	const deleted = [];
	const objects = new Map();
	const multipart = new Map();
	const gates = [];
	const inFlight = new Set();
	const startWaiters = [];
	let etagCounter = 0;
	let uploadCounter = 0;

	const nextEtag = () => `"etag-${++etagCounter}"`;

	const notifyStarted = () =>
	{
		for (const waiter of [...startWaiters])
		{
			if (started.length >= waiter.count)
			{
				startWaiters.splice(startWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	};

	const waitAtGate = async (key) =>
	{
		for (const gate of gates)
		{
			if (gate.matches(key))
			{
				await gate.passage();
			}
		}
	};

	const handlers = {
		async PutObject(input)
		{
			started.push(input.Key);
			notifyStarted();
			await waitAtGate(input.Key);

			const etag = nextEtag();

			objects.set(input.Key, {
				body: toBuffer(input.Body),
				metadata: { ...(input.Metadata ?? {}) },
				etag,
			});

			return { ETag: etag };
		},

		async CreateMultipartUpload(input)
		{
			started.push(input.Key);
			notifyStarted();

			const uploadId = `upload-${++uploadCounter}`;

			multipart.set(uploadId, {
				key: input.Key,
				metadata: { ...(input.Metadata ?? {}) },
				parts: new Map(),
			});

			return { UploadId: uploadId, Bucket: input.Bucket, Key: input.Key };
		},

		async UploadPart(input)
		{
			await waitAtGate(input.Key);

			const upload = multipart.get(input.UploadId);

			if (!upload)
			{
				throw s3Error("NoSuchUpload", 404);
			}

			upload.parts.set(input.PartNumber, toBuffer(input.Body));

			return { ETag: `"part-${input.PartNumber}"` };
		},

		async CompleteMultipartUpload(input)
		{
			await waitAtGate(input.Key);

			const upload = multipart.get(input.UploadId);

			if (!upload)
			{
				throw s3Error("NoSuchUpload", 404);
			}

			const parts = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]);
			const body = parts.every(([, part]) => part !== null)
				? Buffer.concat(parts.map(([, part]) => part))
				: null;
			const etag = nextEtag();

			objects.set(upload.key, { body, metadata: upload.metadata, etag });
			multipart.delete(input.UploadId);

			return { ETag: etag, Bucket: input.Bucket, Key: input.Key };
		},

		async AbortMultipartUpload(input)
		{
			multipart.delete(input.UploadId);

			return {};
		},

		// The bucket always exists; ensureOrderFilesBucket only needs a successful HEAD.
		async HeadBucket()
		{
			return {};
		},

		async CreateBucket()
		{
			return {};
		},

		async DeleteObjects(input)
		{
			for (const { Key } of input.Delete?.Objects ?? [])
			{
				objects.delete(Key);
				deleted.push(Key);
			}

			return { Deleted: [], Errors: [] };
		},

		async HeadObject(input)
		{
			const object = objects.get(input.Key);

			if (!object)
			{
				throw s3Error("NotFound", 404);
			}

			return {
				ETag: object.etag,
				ContentLength: object.body?.length ?? 0,
				Metadata: { ...object.metadata },
			};
		},

		async CopyObject(input)
		{
			const sourceKey = String(input.CopySource).split("/").slice(1).join("/");
			const source = objects.get(sourceKey);

			if (!source)
			{
				throw s3Error("NoSuchKey", 404);
			}

			if (input.CopySourceIfMatch && input.CopySourceIfMatch !== source.etag)
			{
				throw s3Error("PreconditionFailed", 412);
			}

			const etag = nextEtag();

			objects.set(input.Key, {
				body: source.body,
				metadata: input.MetadataDirective === "REPLACE"
					? { ...(input.Metadata ?? {}) }
					: { ...source.metadata },
				etag,
			});

			return { CopyObjectResult: { ETag: etag } };
		},
	};

	return {
		calls,
		started,
		deleted,
		objects,

		// Read by @aws-sdk/lib-storage's Upload.
		config: {
			endpoint: async () => ({ protocol: "http:", hostname: "fake-s3.invalid", port: 9000, path: "/" }),
			forcePathStyle: true,
			requestChecksumCalculation: async () => "WHEN_REQUIRED",
			requestHandler: {},
		},

		/**
		 * @param {{ constructor: { name: string }, input: Record<string, any> }} command
		 * @returns {Promise<Record<string, any>>}
		 */
		send(command)
		{
			const type = command?.constructor?.name?.replace(/Command$/, "");
			const handler = handlers[type];

			if (!handler)
			{
				return Promise.reject(new Error(`FakeS3: unsupported command ${type}`));
			}

			calls.push({ type, key: command.input?.Key, input: command.input });

			const running = handler(command.input ?? {});

			inFlight.add(running);
			running.then(
				() => inFlight.delete(running),
				() => inFlight.delete(running),
			);

			return running;
		},

		destroy()
		{
		},

		/**
		 * @param {string} type Command name without "Command".
		 * @returns {FakeS3Call[]}
		 */
		callsOf(type)
		{
			return calls.filter((call) => call.type === type);
		},

		/**
		 * Holds PutObject, UploadPart and CompleteMultipartUpload for matching keys
		 * until `release()` or `fail()` is called. Once decided, the gate stays that
		 * way for later commands too.
		 *
		 * @param {string | ((key: string) => boolean)} [match] A key, a predicate, or
		 *   nothing (or "*") for every key. Keys are generated by the code under
		 *   test, so tests usually gate everything.
		 * @returns {FakeS3Gate}
		 */
		gate(match)
		{
			let decide;
			const decision = new Promise((resolve) =>
			{
				decide = resolve;
			});
			const entry = {
				matches: createMatcher(match),
				passage: () => decision.then((outcome) =>
				{
					if (outcome.error)
					{
						throw outcome.error;
					}
				}),
			};

			gates.push(entry);

			return {
				release: () => decide({}),
				fail: (err) => decide({ error: err }),
			};
		},

		/**
		 * @param {string} key
		 * @param {{ body?: string | Uint8Array, metadata?: Record<string, string> }} [object]
		 */
		seed(key, { body = "", metadata = {} } = {})
		{
			objects.set(key, { body: toBuffer(body), metadata: { ...metadata }, etag: nextEtag() });
		},

		/**
		 * @param {number} count
		 * @returns {Promise<void>}
		 */
		waitForStarted(count)
		{
			if (started.length >= count)
			{
				return Promise.resolve();
			}

			return new Promise((resolve) => startWaiters.push({ count, resolve }));
		},

		/** @returns {Promise<void>} Resolves once every send issued so far has finished, successfully or not. */
		async settled()
		{
			while (inFlight.size > 0)
			{
				await Promise.allSettled([...inFlight]);
			}
		},

		reset()
		{
			calls.length = 0;
			started.length = 0;
			deleted.length = 0;
			objects.clear();
			multipart.clear();
			gates.length = 0;
			startWaiters.length = 0;
		},
	};
}
