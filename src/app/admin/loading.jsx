import { Loader2 } from "lucide-react";

// Shown inside the admin layout, so the top bar stays put while a page loads.
export default function AdminLoading()
{
	return (
		<p className="flex items-center gap-2 py-12 text-sm text-muted" role="status">
			<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
			Wczytywanie...
		</p>
	);
}
