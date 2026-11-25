import { Loader2 } from "lucide-react";

// Route-level loading UI: shown immediately while server components wait on
// Kratos/Postgres, instead of a blank page.
export default function Loading()
{
	return (
		<div role="status" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-transparent">
			<Loader2 size={32} className="animate-spin text-muted" aria-hidden="true" />
			<p className="text-lg font-semibold text-foreground">ProjectO</p>
			<span className="sr-only">Wczytywanie</span>
		</div>
	);
}
