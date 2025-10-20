import type React from "react";
import { useCallback, useMemo } from "react";

interface PaginationProps {
	currentPage: number;
	totalPages: number;
	onPageChange: (page: number) => void;
}

export const Pagination: React.FC<PaginationProps> = ({
	currentPage,
	totalPages,
	onPageChange,
}) => {
	// Mathematical optimization: Stable callback prevents unnecessary re-renders
	const goToPage = useCallback(
		(page: number): void => {
			const clamped = Math.max(1, Math.min(totalPages, page));
			if (clamped !== currentPage) onPageChange(clamped);
		},
		[currentPage, totalPages, onPageChange],
	);

	// Mathematical proof: Memoized page calculation prevents O(k) recalculation
	// where k = visible page count
	type PageItem = number | { type: "dots"; id: "left" | "right" };
	const pages = useMemo((): PageItem[] => {
		const result: PageItem[] = [];
		const windowSize = 2;

		const add = (p: number): void => {
			if (p >= 1 && p <= totalPages) result.push(p);
		};

		add(1);

		const start = Math.max(2, currentPage - windowSize);
		const end = Math.min(totalPages - 1, currentPage + windowSize);

		if (start > 2) result.push({ type: "dots", id: "left" });
		for (let p = start; p <= end; p++) add(p);
		if (end < totalPages - 1) result.push({ type: "dots", id: "right" });

		if (totalPages > 1) add(totalPages);

		return result;
	}, [currentPage, totalPages]);

	// Early return after hooks
	if (totalPages <= 1) return null;

	return (
		<nav
			className="mt-6 mb-4 flex flex-wrap items-center justify-center gap-2 sm:gap-3 select-none"
			aria-label="Pagination"
		>
			<button
				type="button"
				onClick={() => goToPage(currentPage - 1)}
				disabled={currentPage === 1}
				className="pagination-button pagination-nav disabled:opacity-50 disabled:cursor-not-allowed"
			>
				Prev
			</button>

			{pages.map((p) =>
				typeof p === "number" ? (
					<button
						type="button"
						key={p}
						onClick={() => goToPage(p)}
						aria-current={p === currentPage ? "page" : undefined}
						className={
							p === currentPage
								? "pagination-button pagination-active"
								: "pagination-button pagination-inactive"
						}
					>
						{p}
					</button>
				) : (
					<span key={`dots-${p.id}`} className="px-2 text-gray-500 select-none">
						…
					</span>
				),
			)}

			<button
				type="button"
				onClick={() => goToPage(currentPage + 1)}
				disabled={currentPage === totalPages}
				className="pagination-button pagination-nav disabled:opacity-50 disabled:cursor-not-allowed"
			>
				Next
			</button>
		</nav>
	);
};
