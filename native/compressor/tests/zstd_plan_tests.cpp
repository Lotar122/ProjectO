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
	// carries one extra ZSTDMT_CCtx* in ZSTD_CCtx. The pinned build is multithreaded too, so the values
	// match exactly. A single-threaded build fails here loudly: zstd would otherwise ignore --threads.
	std::uint64_t pinnedEstimate(std::uint64_t tableValue)
	{
		REQUIRE_MESSAGE(zstdSupportsThreads(), "libzstd was built without ZSTD_MULTITHREAD");
		return tableValue;
	}

	std::uint64_t windowOf(const ZstdPlan& plan)
	{
		return std::uint64_t{1} << plan.params.windowLog;
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

TEST_CASE("the zstd start line reports every parameter, the threads, the estimate and the budget")
{
	const ZstdPlan plan = planZstd(128 * MiB + 1, 28);
	const ZstdThreading threading = chooseZstdThreading(plan, 4, 6144 * MiB);
	// 4 workers need about 4 x 2.5 GiB at window 28: the 6 GiB budget leaves room for 2.
	CHECK(threading.workers == 2);
	CHECK(zstdStartLine(plan, threading, 6144 * MiB).str()
		== "{\"type\":\"start\",\"codec\":\"zstd\",\"level\":22,\"windowLog\":28,\"chainLog\":29,\"hashLog\":25,"
		   "\"searchLog\":9,\"minMatch\":3,\"targetLength\":999,\"strategy\":9,\"ldm\":true,\"ldmHashLog\":24,"
		   "\"ldmMinMatch\":32,\"ldmBucketSizeLog\":8,\"ldmHashRateLog\":4,\"threads\":4,\"workers\":2,"
		   "\"jobSize\":8388608,\"overlapLog\":4,\"estimatedBytes\":"
			+ std::to_string(zstdEstimate(plan, 2)) + ",\"budgetBytes\":6442450944}\n");

	const ZstdThreading single = chooseZstdThreading(plan, 1, 6144 * MiB);
	CHECK(zstdStartLine(plan, single, 6144 * MiB).str().find(
		"\"threads\":1,\"workers\":0,\"jobSize\":8388608,\"overlapLog\":4,\"estimatedBytes\":"
		+ std::to_string(pinnedEstimate(2'686'042'783)) + ",") != std::string::npos);
}

TEST_CASE("the linked libzstd is multithreaded and keeps nbWorkers as set")
{
	REQUIRE(zstdSupportsThreads());
	const ZSTD_bounds bounds = ZSTD_cParam_getBounds(ZSTD_c_nbWorkers);
	REQUIRE(ZSTD_isError(bounds.error) == 0U);
	CHECK(bounds.upperBound >= static_cast<int>(kMaxThreads));

	// zstd clamps out-of-range values silently and a single-threaded build refuses any value above 0,
	// so the value read back is the proof that it applies.
	ZSTD_CCtx* cctx = ZSTD_createCCtx();
	REQUIRE(cctx != nullptr);
	for (const int workers : {0, 2, 4, static_cast<int>(kMaxThreads)})
	{
		CAPTURE(workers);
		CHECK(ZSTD_CCtx_setParameter(cctx, ZSTD_c_nbWorkers, workers) == static_cast<std::size_t>(workers));
		int value = -1;
		CHECK(ZSTD_isError(ZSTD_CCtx_getParameter(cctx, ZSTD_c_nbWorkers, &value)) == 0U);
		CHECK(value == workers);
	}
	ZSTD_freeCCtx(cctx);
}

TEST_CASE("job layout: window / 8 clamped to 512 KiB..8 MiB, overlap == job size, one job per jobSize bytes")
{
	for (const std::uint64_t size : sampledSizes())
	{
		CAPTURE(size);
		const ZstdPlan plan = planZstd(size, 28);
		const ZstdJobs& jobs = plan.jobs;
		CHECK(jobs.jobSize == std::clamp(windowOf(plan) / 8, kZstdMinJobBytes, kZstdMaxJobBytes));
		CHECK(jobs.count == (size + jobs.jobSize - 1) / jobs.jobSize);
		CHECK(jobs.overlapLog >= 1);
		CHECK(jobs.overlapLog <= 9);
		if (jobs.count >= 2)
		{
			// zstd raises a job smaller than the overlap to the overlap: equal means it keeps the size.
			CHECK((windowOf(plan) >> (9 - jobs.overlapLog)) == jobs.jobSize);
		}
	}
	CHECK(planZstd(8 * MiB, 28).jobs == ZstdJobs{MiB, 6, 8});
	CHECK(planZstd(GiB, 28).jobs == ZstdJobs{8 * MiB, 4, 128});
	CHECK(planZstd(512 * KiB, 28).jobs.count == 1);
}

TEST_CASE("the MT estimate grows with every worker and is above the single-threaded one")
{
	for (const std::uint64_t size : {MiB + 1, 8 * MiB, 64 * MiB, GiB})
	{
		CAPTURE(size);
		const ZstdPlan plan = planZstd(size, 28);
		CHECK(zstdEstimate(plan, 0) == plan.estimatedBytes);
		CHECK(plan.workerContextBytes > 0);
		CHECK(plan.workerContextBytes < plan.estimatedBytes);
		std::uint64_t previous = plan.estimatedBytes;
		for (int workers = 2; workers <= static_cast<int>(kMaxThreads); ++workers)
		{
			const std::uint64_t estimate = zstdEstimate(plan, workers);
			CHECK(estimate > previous);
			CHECK(estimate >= static_cast<std::uint64_t>(workers) * plan.workerContextBytes);
			previous = estimate;
		}
	}
}

TEST_CASE("chooseZstdThreading: no more workers than jobs, lowered to fit the budget, 0 or 1 is single-threaded")
{
	const ZstdPlan plan = planZstd(8 * MiB, 28);
	CHECK(chooseZstdThreading(plan, 4, 6144 * MiB).workers == 4);
	CHECK(chooseZstdThreading(plan, 4, 6144 * MiB).estimatedBytes == zstdEstimate(plan, 4));
	CHECK(chooseZstdThreading(plan, 64, 6144 * MiB).workers == 8);
	CHECK(chooseZstdThreading(plan, 1, 6144 * MiB).workers == 0);
	CHECK(chooseZstdThreading(plan, 0, 6144 * MiB).workers == 0);
	CHECK(chooseZstdThreading(plan, 1, 6144 * MiB).estimatedBytes == plan.estimatedBytes);
	CHECK(chooseZstdThreading(planZstd(300 * KiB, 28), 4, 6144 * MiB).workers == 0);

	// A budget that fits exactly 3 workers (with the header allowance) gets 3; one byte less gets 2.
	const std::uint64_t three = zstdEstimate(plan, 3) + BudgetAllocator::kHeaderAllowanceBytes;
	CHECK(chooseZstdThreading(plan, 4, three).workers == 3);
	CHECK(chooseZstdThreading(plan, 4, three - 1).workers == 2);
	// Too small for 2 workers: single-threaded, whose estimate the caller still checks (exit 4 if over).
	const std::uint64_t two = zstdEstimate(plan, 2) + BudgetAllocator::kHeaderAllowanceBytes;
	const ZstdThreading fallback = chooseZstdThreading(plan, 4, two - 1);
	CHECK(fallback.workers == 0);
	CHECK(fallback.estimatedBytes == plan.estimatedBytes);
	CHECK(fallback.requested == 4);
	CHECK(chooseZstdThreading(plan, 4, 64 * MiB).workers == 0);
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
