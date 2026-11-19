#include <doctest/doctest.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <type_traits>
#include <vector>

#include <zstd.h>

#include "projecto/brotli_codec.hpp"
#include "projecto/codec_common.hpp"
#include "projecto/zstd_codec.hpp"

using namespace projecto;

namespace
{
	constexpr std::uint64_t KiB = std::uint64_t{1} << 10;
	constexpr std::uint64_t MiB = std::uint64_t{1} << 20;
	constexpr std::uint64_t GiB = std::uint64_t{1} << 30;

	struct WindowVector
	{
		std::uint64_t size;
		std::uint64_t maxWindowLog;
		std::uint64_t expected;
	};

	// phase4-amendments.md A6, shared with tests/file-compression.test.mjs.
	constexpr std::array kWindowVectors{
		WindowVector{1, 28, 10},
		WindowVector{1000, 28, 10},
		WindowVector{1024, 28, 10},
		WindowVector{1025, 28, 11},
		WindowVector{300 * KiB, 28, 19},
		WindowVector{64 * MiB, 28, 26},
		WindowVector{64 * MiB + 1, 28, 27},
		WindowVector{128 * MiB, 28, 27},
		WindowVector{128 * MiB + 1, 28, 28},
		WindowVector{250 * MiB, 28, 28},
		WindowVector{GiB, 28, 28},
		WindowVector{250 * MiB, 27, 27},
		WindowVector{250 * MiB, 24, 24},
	};

	struct PlanVector
	{
		std::uint64_t size;
		std::uint64_t maxWindowLog;
		int windowLog;
		int chainLog;
		int hashLog;
		int searchLog;
		std::uint64_t estimatedBytes;
	};

	// phase4-amendments.md A6, exact for libzstd 1.5.7. minMatch 3, targetLength 999 and
	// strategy 9 (btultra2) hold for every row.
	constexpr std::array kPlanVectors{
		PlanVector{1, 28, 10, 11, 7, 10, 196'516},
		PlanVector{1'024, 28, 10, 11, 11, 10, 204'196},
		PlanVector{1'025, 28, 11, 12, 12, 10, 233'447},
		PlanVector{4'096, 28, 12, 13, 13, 10, 291'887},
		PlanVector{300 * KiB, 28, 19, 20, 20, 9, 10'797'855},
		PlanVector{8 * MiB, 28, 23, 24, 24, 9, 148'425'375},
		PlanVector{32 * MiB, 28, 25, 26, 25, 9, 454'615'711},
		PlanVector{64 * MiB, 28, 26, 27, 25, 9, 773'391'007},
		PlanVector{64 * MiB + 1, 28, 27, 28, 25, 9, 1'410'941'599},
		PlanVector{128 * MiB, 28, 27, 28, 25, 9, 1'410'941'599},
		PlanVector{128 * MiB + 1, 28, 28, 29, 25, 9, 2'686'042'783},
		PlanVector{250 * MiB, 28, 28, 29, 25, 9, 2'686'042'783},
		PlanVector{GiB, 28, 28, 29, 25, 9, 2'686'042'783},
		PlanVector{250 * MiB, 27, 27, 28, 25, 9, 1'410'941'599},
	};

	// The table was measured with the system libzstd 1.5.7, which is built with ZSTD_MULTITHREAD and so
	// carries one extra ZSTDMT_CCtx* in ZSTD_CCtx. The pinned build is single-threaded (phase4.md 10.2),
	// so its estimates are exactly one pointer smaller. Detected at run time from the nbWorkers bounds.
	std::uint64_t pinnedEstimate(std::uint64_t tableValue)
	{
		const ZSTD_bounds workers = ZSTD_cParam_getBounds(ZSTD_c_nbWorkers);
		const bool multithreaded = ZSTD_isError(workers.error) == 0U && workers.upperBound > 0;
		return multithreaded ? tableValue : tableValue - sizeof(void*);
	}

	std::vector<std::uint64_t> sampledSizes()
	{
		std::vector<std::uint64_t> sizes;
		for (std::uint64_t power = 1; power <= GiB; power <<= 1U)
		{
			sizes.push_back(power);
			sizes.push_back(power + 1);
			if (power > 1)
			{
				sizes.push_back(power - 1);
			}
		}
		return sizes;
	}
}

TEST_CASE("windowLogFor matches the JS vectors")
{
	for (const WindowVector& vector : kWindowVectors)
	{
		CAPTURE(vector.size);
		CAPTURE(vector.maxWindowLog);
		CHECK(windowLogFor(vector.size, vector.maxWindowLog) == vector.expected);
	}
	static_assert(windowLogFor(0, 28) == 10);
	static_assert(windowLogFor(2, 28) == 10);
}

TEST_CASE("planZstd matches the amendment's vector table exactly (libzstd 1.5.7)")
{
	for (const PlanVector& vector : kPlanVectors)
	{
		CAPTURE(vector.size);
		CAPTURE(vector.maxWindowLog);
		const ZstdPlan plan = planZstd(vector.size, vector.maxWindowLog);
		const ZstdParams& p = plan.params;
		CHECK(p.windowLog == vector.windowLog);
		CHECK(p.chainLog == vector.chainLog);
		CHECK(p.hashLog == vector.hashLog);
		CHECK(p.searchLog == vector.searchLog);
		CHECK(p.minMatch == 3);
		CHECK(p.targetLength == 999);
		CHECK(p.strategy == 9);
		CHECK(p.ldmHashRateLog == 4);
		CHECK(p.ldmMinMatch == 32);
		CHECK(p.ldmHashLog == std::max(6, vector.windowLog - 4));
		CHECK(p.ldmBucketSizeLog == std::min(8, p.ldmHashLog));
		CHECK(plan.estimatedBytes == pinnedEstimate(vector.estimatedBytes));
	}
}

TEST_CASE("planZstd keeps windowLog <= 28 and chainLog == windowLog + 1 from 1 B to 1 GiB")
{
	for (const std::uint64_t size : sampledSizes())
	{
		CAPTURE(size);
		const ZstdPlan plan = planZstd(size, 28);
		CHECK(plan.params.windowLog <= 28);
		CHECK(plan.params.chainLog == plan.params.windowLog + 1);
		CHECK(static_cast<std::uint64_t>(plan.params.windowLog) == windowLogFor(size, 28));
		CHECK(plan.estimatedBytes > 0);
	}
}

TEST_CASE("planZstd clamps a maxWindowLog outside 10 to 28")
{
	CHECK(planZstd(250 * MiB, 40).params.windowLog == 28);
	CHECK(planZstd(250 * MiB, 0).params.windowLog == 10);
}

TEST_CASE("planZstd depends on the size alone: no budget input, same result every time")
{
	static_assert(std::is_same_v<decltype(&planZstd), ZstdPlan (*)(std::uint64_t, std::uint64_t)>,
		"planZstd must not take a budget");
	const ZstdPlan first = planZstd(8 * MiB, 28);
	const ZstdPlan second = planZstd(8 * MiB, 28);
	CHECK(first.params == second.params);
	CHECK(first.estimatedBytes == second.estimatedBytes);
}

TEST_CASE("estimating with LDM on does not crash (SIGFPE regression) at 1 B and 250 MiB")
{
	CHECK(planZstd(1, 28).estimatedBytes == pinnedEstimate(196'516));
	CHECK(planZstd(250 * MiB, 28).estimatedBytes == pinnedEstimate(2'686'042'783));
}

TEST_CASE("the zstd start line reports every parameter, the estimate and the budget")
{
	const ZstdPlan plan = planZstd(128 * MiB + 1, 28);
	CHECK(zstdStartLine(plan, 6144 * MiB).str()
		== "{\"type\":\"start\",\"codec\":\"zstd\",\"level\":22,\"windowLog\":28,\"chainLog\":29,\"hashLog\":25,"
		   "\"searchLog\":9,\"minMatch\":3,\"targetLength\":999,\"strategy\":9,\"ldm\":true,\"ldmHashLog\":24,"
		   "\"ldmMinMatch\":32,\"ldmBucketSizeLog\":8,\"ldmHashRateLog\":4,\"estimatedBytes\":"
			+ std::to_string(pinnedEstimate(2'686'042'783)) + ",\"budgetBytes\":6442450944}\n");
}

TEST_CASE("planBrotli: quality 11, window sized to the file, large-window only above 24")
{
	const BrotliPlan small = planBrotli(1, 28);
	CHECK(small.quality == 11);
	CHECK(small.lgwin == 10);
	CHECK_FALSE(small.largeWindow);
	CHECK(small.sizeHint == 1);

	const BrotliPlan standard = planBrotli(16 * MiB, 28);
	CHECK(standard.lgwin == 24);
	CHECK_FALSE(standard.largeWindow);

	const BrotliPlan large = planBrotli(16 * MiB + 1, 28);
	CHECK(large.lgwin == 25);
	CHECK(large.largeWindow);

	const BrotliPlan biggest = planBrotli(250 * MiB, 28);
	CHECK(biggest.lgwin == 28);
	CHECK(biggest.largeWindow);
	CHECK(biggest.sizeHint == 250 * MiB);

	const BrotliPlan capped = planBrotli(GiB, 24);
	CHECK(capped.lgwin == 24);
	CHECK_FALSE(capped.largeWindow);
	CHECK(capped.sizeHint == GiB);
}

TEST_CASE("planBrotli has an estimate (the static build links the extra API)")
{
	const BrotliPlan plan = planBrotli(250 * MiB, 28);
	REQUIRE(plan.estimatedBytes.has_value());
	CHECK(*plan.estimatedBytes > (std::uint64_t{1} << 28));
	CHECK(brotliStartLine(plan, 6144 * MiB).str().starts_with(
		"{\"type\":\"start\",\"codec\":\"br\",\"quality\":11,\"lgwin\":28,\"largeWindow\":true,\"estimatedBytes\":"));
}
