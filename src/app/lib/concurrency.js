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
