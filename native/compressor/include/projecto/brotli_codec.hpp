#pragma once

#include <cstdint>
#include <iosfwd>
#include <optional>

#include "projecto/budget_allocator.hpp"
#include "projecto/codec_common.hpp"
#include "projecto/protocol.hpp"

namespace projecto
{
	inline constexpr int kBrotliQuality = 11;
	// Largest window of a standard (RFC 7932) stream. Above it the large-window
	// format is used (phase4-amendments.md A4).
	inline constexpr int kBrotliStandardMaxWindowLog = 24;
	inline constexpr std::uint64_t kBrotliMaxSizeHint = std::uint64_t{1} << 30;

	struct BrotliPlan
	{
		int quality = kBrotliQuality;
		int lgwin = 0;
		bool largeWindow = false;
		std::uint32_t sizeHint = 0;
		// BrotliEncoderEstimatePeakMemoryUsage; empty when the library cannot tell.
		std::optional<std::uint64_t> estimatedBytes;
	};

	// Quality 11, lgwin = windowLogFor(size, min(maxWindowLog, 28)), large-window
	// mode only when lgwin > 24, size hint min(size, 2^30), generic mode.
	BrotliPlan planBrotli(std::uint64_t size, std::uint64_t maxWindowLog);

	// {"type":"start","codec":"br","quality":11,"lgwin":...,"largeWindow":...,"budgetBytes":...}
	JsonLine brotliStartLine(const BrotliPlan& plan, std::uint64_t budgetBytes);

	// Streams the input into the output with the counting allocator as the only
	// memory cap (no estimate check; request.budgetBytes is not used here, the
	// allocator carries the cap). Removes the output on any failure.
	CompressOutcome encodeBrotli(const BrotliPlan& plan, const CompressRequest& request, ProgressReporter& progress,
		BudgetAllocator& allocator);

	// The whole brotli run: plan, start line, then exit 4 before the output is
	// created when the estimate plus the header allowance (fitsBudget) is over
	// budget, otherwise encodeBrotli.
	CompressOutcome compressBrotli(const CompressRequest& request, std::ostream& out);
}
