"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { pluralPl } from "@/app/lib/pluralPl";

export default function OrdersPagination({
	currentPage,
	isLoading,
	onPageChange,
	pageSize,
	totalCount,
	totalPages,
})
{
	if (totalCount === 0)
	{
		return null;
	}

	const startItem = (currentPage - 1) * pageSize + 1;
	const endItem = Math.min(currentPage * pageSize, totalCount);

	return (
		<div className="flex flex-col gap-4 rounded-xl border border-line bg-surface px-4 py-4 sm:px-5 md:flex-row md:items-center md:justify-between">
			<p className="text-sm tabular-nums text-muted">
				Wyświetlono {startItem}-{endItem} z {totalCount} {pluralPl(totalCount, ["zlecenia", "zleceń", "zleceń"])}
			</p>

			<div className="flex items-center justify-between gap-3 md:justify-end">
				<button
					type="button"
					onClick={() => onPageChange(currentPage - 1)}
					disabled={currentPage <= 1 || isLoading}
					className="btn btn-secondary min-w-11 px-2.5 sm:px-4">
					<ChevronLeft className="h-4 w-4" aria-hidden="true" />
					<span className="sr-only sm:not-sr-only">Poprzednia</span>
				</button>

				<span className="min-w-0 text-center text-sm font-medium tabular-nums whitespace-nowrap text-foreground sm:min-w-28">
					Strona {currentPage} z {totalPages}
				</span>

				<button
					type="button"
					onClick={() => onPageChange(currentPage + 1)}
					disabled={currentPage >= totalPages || isLoading}
					className="btn btn-secondary min-w-11 px-2.5 sm:px-4">
					<span className="sr-only sm:not-sr-only">Następna</span>
					<ChevronRight className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}
