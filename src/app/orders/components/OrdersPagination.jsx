"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

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
		<div className="mt-8 flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/85 px-4 py-4 backdrop-blur sm:px-5 md:flex-row md:items-center md:justify-between">
			<p className="text-sm text-slate-400">
				Wyświetlono {startItem}-{endItem} z {totalCount} zleceń
			</p>

			<div className="flex items-center justify-between gap-3 md:justify-end">
				<button
					type="button"
					onClick={() => onPageChange(currentPage - 1)}
					disabled={currentPage <= 1 || isLoading}
					className="inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-lg border border-slate-700 px-2.5 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 sm:px-4">
					<ChevronLeft className="h-4 w-4" />
					<span className="sr-only sm:not-sr-only">Poprzednia</span>
				</button>

				<span className="min-w-0 text-center text-sm font-medium whitespace-nowrap text-slate-200 sm:min-w-28">
					Strona {currentPage} z {totalPages}
				</span>

				<button
					type="button"
					onClick={() => onPageChange(currentPage + 1)}
					disabled={currentPage >= totalPages || isLoading}
					className="inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-lg border border-slate-700 px-2.5 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 sm:px-4">
					<span className="sr-only sm:not-sr-only">Następna</span>
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
}
