export const KRATOS_PUBLIC =
	process.env.NEXT_PUBLIC_KRATOS_PUBLIC_URL ||
	"https://orto.lotar122.dev/kratos";

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
