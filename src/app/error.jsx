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
				<h1 className="mb-2 text-3xl font-bold text-balance text-foreground">Wystąpił błąd.</h1>
				<p className="mb-6 text-pretty text-muted">
					Nie udało się załadować strony. Spróbuj ponownie za chwilę.
				</p>
				<button
					type="button"
					onClick={retry}
					className="btn btn-primary px-5">
					Spróbuj ponownie
				</button>
			</div>
		</div>
	);
}
