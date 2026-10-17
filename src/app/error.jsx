"use client";

// Route-level error UI: a failed render (e.g. Kratos or the database timing
// out) shows this instead of a blank page.
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";

export default function Error({ error, reset })
{
	const router = useRouter();

	// The failure is usually server-side, so refetch the server components too.
	const retry = () =>
	{
		startTransition(() =>
		{
			router.refresh();
			reset();
		});
	};

	useEffect(() =>
	{
		console.error(error);
	}, [error]);

	return (
		<div className="flex min-h-dvh items-center justify-center bg-transparent p-4">
			<div className="text-center">
				<h1 className="mb-2 text-3xl font-bold text-white">Wystąpił błąd.</h1>
				<p className="mb-6 text-gray-400">
					Nie udało się załadować strony. Spróbuj ponownie za chwilę.
				</p>
				<button
					type="button"
					onClick={retry}
					className="rounded-lg border border-white/25 px-5 py-2 font-semibold text-white transition hover:bg-white/10">
					Spróbuj ponownie
				</button>
			</div>
		</div>
	);
}
