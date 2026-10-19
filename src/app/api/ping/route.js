export async function GET()
{
	return new Response(JSON.stringify({ message: "Pong!" }), {
		headers: { "Content-Type": "application/json" },
	});
}
