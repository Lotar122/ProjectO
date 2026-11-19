// NEXT_PUBLIC_* is inlined at build time, and this module is also bundled into
// client components. The check below therefore only runs on the server: in the
// browser NEXT_PHASE does not exist, so it could not tell a build from a run.
export const KRATOS_PUBLIC = process.env.NEXT_PUBLIC_KRATOS_PUBLIC_URL || "";

if (!KRATOS_PUBLIC && typeof window === "undefined")
{
	const message =
		"NEXT_PUBLIC_KRATOS_PUBLIC_URL is not set (it must be present at build time)";

	if (
		process.env.NODE_ENV === "production" &&
		process.env.NEXT_PHASE !== "phase-production-build"
	)
	{
		throw new Error(message);
	}

	console.warn(message);
}

// Server-side calls to Kratos must never wait forever: a hung request blocks
// the page render and the user sees a blank screen.
export const KRATOS_TIMEOUT_MS = 8000;

export function getKratosNodeValue(flow, nodeName)
{
	return (
		flow?.ui?.nodes?.find((node) => node.attributes?.name === nodeName)?.attributes
			?.value || ""
	);
}

export function getKratosFlowMessages(flow, group)
{
	const topLevelMessages = flow?.ui?.messages || [];
	const nodeMessages =
		flow?.ui?.nodes
			?.filter((node) => !group || node.group === group)
			.flatMap((node) => node.messages || []) || [];

	return [...topLevelMessages, ...nodeMessages]
		.map((message) => message?.text)
		.filter(Boolean);
}
