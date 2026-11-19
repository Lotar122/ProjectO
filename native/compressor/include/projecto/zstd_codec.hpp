#pragma once

#include <cstdint>
#include <iosfwd>

#include "projecto/budget_allocator.hpp"
#include "projecto/codec_common.hpp"
#include "projecto/protocol.hpp"

namespace projecto
{
	inline constexpr int kZstdLevel = 22;

	// Every compression parameter handed to libzstd, set explicitly
	// (phase4-amendments.md A2). LDM, checksum and content size are always on.
	struct ZstdParams
	{
		int windowLog = 0;
		int chainLog = 0;
		int hashLog = 0;
		int searchLog = 0;
		int minMatch = 0;
		int targetLength = 0;
		int strategy = 0;
		int ldmHashLog = 0;
		int ldmMinMatch = 0;
		int ldmBucketSizeLog = 0;
		int ldmHashRateLog = 0;

		bool operator==(const ZstdParams&) const = default;
	};

	struct ZstdPlan
	{
		ZstdParams params;
		// ZSTD_estimateCStreamSize_usingCCtxParams for these parameters.
		std::uint64_t estimatedBytes = 0;
	};

	// Level 22 with windowLog = windowLogFor(size, maxWindowLog) (capped at 28)
	// and chainLog = windowLog + 1. Depends on the size alone: there is no budget
	// input, so the budget can never weaken the parameters.
	ZstdPlan planZstd(std::uint64_t size, std::uint64_t maxWindowLog);

	// {"type":"start","codec":"zstd","level":22,"windowLog":...,"budgetBytes":...}
	JsonLine zstdStartLine(const ZstdPlan& plan, std::uint64_t budgetBytes);

	// Streams the input into the output with the counting allocator as the only
	// memory cap (no estimate check; request.budgetBytes is not used here, the
	// allocator carries the cap). Removes the output on any failure.
	CompressOutcome encodeZstd(const ZstdParams& params, const CompressRequest& request, ProgressReporter& progress,
		BudgetAllocator& allocator);

	// The whole zstd run: plan, start line, then exit 4 before the output is
	// created when the estimate plus the header allowance (fitsBudget) is over
	// budget, otherwise encodeZstd.
	CompressOutcome compressZstd(const CompressRequest& request, std::ostream& out);
}
