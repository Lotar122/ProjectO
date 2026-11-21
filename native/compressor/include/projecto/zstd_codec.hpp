#pragma once

#include <cstdint>
#include <iosfwd>

#include "projecto/budget_allocator.hpp"
#include "projecto/codec_common.hpp"
#include "projecto/protocol.hpp"

namespace projecto
{
	inline constexpr int kZstdLevel = 22;

	// Job size bounds of a multithreaded run. The lower one is ZSTDMT_JOBSIZE_MIN; the upper
	// one bounds how long a failing run waits for the jobs already in flight (see encodeZstd).
	inline constexpr std::uint64_t kZstdMinJobBytes = std::uint64_t{512} << 10;
	inline constexpr std::uint64_t kZstdMaxJobBytes = std::uint64_t{8} << 20;
	// Multithreaded state the per-part formula of zstdEstimate does not cover: the outer and
	// the MT context, the job table, the thread pool, the buffer and context pools. Measured
	// at well under 1 MiB for 64 workers (tests/zstd_plan_tests.cpp checks the whole estimate
	// against the allocator's peak).
	inline constexpr std::uint64_t kZstdMtFixedBytes = std::uint64_t{1} << 20;
	inline constexpr std::uint64_t kZstdMtPerWorkerBytes = std::uint64_t{64} << 10;

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

	// How a multithreaded run cuts the input into jobs; the size alone decides it, so the
	// output is the same for any worker count from 2 up (zstd's MT output does not depend
	// on the number of workers, only on the job layout).
	struct ZstdJobs
	{
		// ZSTD_c_jobSize: clamp(2^windowLog / 8, kZstdMinJobBytes, kZstdMaxJobBytes).
		std::uint64_t jobSize = 0;
		// ZSTD_c_overlapLog chosen so that each job reloads exactly jobSize bytes of the input
		// before it (2^windowLog >> (9 - overlapLog) == jobSize): zstd raises the job size to
		// the overlap otherwise, which with the default overlap (the whole window) would make
		// the whole file one job. LDM still covers the whole window: it runs over the input
		// once, in order, outside the jobs.
		int overlapLog = 0;
		// ceil(size / jobSize): workers beyond this would only idle.
		std::uint64_t count = 0;

		bool operator==(const ZstdJobs&) const = default;
	};

	struct ZstdPlan
	{
		ZstdParams params;
		ZstdJobs jobs;
		// ZSTD_estimateCStreamSize_usingCCtxParams for these parameters: the single-threaded run.
		std::uint64_t estimatedBytes = 0;
		// ZSTD_estimateCCtxSize_usingCCtxParams with LDM off: one worker's context (match
		// tables and block buffers; the workers get LDM sequences from the shared LDM pass).
		std::uint64_t workerContextBytes = 0;
	};

	// The worker count a run uses and the estimate it was checked with.
	struct ZstdThreading
	{
		// --threads as given.
		std::uint64_t requested = 0;
		// ZSTD_c_nbWorkers: 0 compresses on the calling thread, 2 or more start that many workers.
		int workers = 0;
		// zstdEstimate(plan, workers).
		std::uint64_t estimatedBytes = 0;
	};

	// Level 22 with windowLog = windowLogFor(size, maxWindowLog) (capped at 28)
	// and chainLog = windowLog + 1, plus the job layout. Depends on the size alone:
	// there is no budget input, so the budget can never weaken the parameters.
	ZstdPlan planZstd(std::uint64_t size, std::uint64_t maxWindowLog);

	// Upper bound of the memory a run with `workers` workers allocates (0: single-threaded,
	// plan.estimatedBytes). For n >= 1 workers, with W = 2^windowLog and J = jobs.jobSize:
	//   n * (workerContextBytes + kZstdMtPerWorkerBytes)   worker contexts
	//   + max(W, n * J) + 3 * J                             input ring buffer (window kept for LDM)
	//   + (2n + 3) * ZSTD_compressBound(J)                  output buffers
	//   + 2^ldmHashLog * 8 + 2^(ldmHashLog - ldmBucketSizeLog)   shared LDM tables
	//   + n * (J / ldmMinMatch) * 12                        LDM sequence buffers
	//   + kZstdMtFixedBytes
	std::uint64_t zstdEstimate(const ZstdPlan& plan, int workers);

	// min(requested, jobs.count) workers, lowered one at a time until zstdEstimate fits the
	// budget (fitsBudget); below 2 the run is single-threaded (0 workers), whose estimate the
	// caller still checks. Never fails: a budget too small for any worker count is exit 4 later.
	ZstdThreading chooseZstdThreading(const ZstdPlan& plan, std::uint64_t requestedThreads, std::uint64_t budgetBytes);

	// True when the linked libzstd was built with ZSTD_MULTITHREAD (nbWorkers can be above 0).
	// Without it zstd refuses nbWorkers > 0; compressZstd then fails with exit 70 instead of
	// quietly running on one thread.
	bool zstdSupportsThreads() noexcept;

	// {"type":"start","codec":"zstd","level":22,"windowLog":...,"threads":4,"workers":4,
	//  "jobSize":...,"overlapLog":...,"estimatedBytes":...,"budgetBytes":...}
	JsonLine zstdStartLine(const ZstdPlan& plan, const ZstdThreading& threading, std::uint64_t budgetBytes);

	// Streams the input into the output with the counting allocator as the only
	// memory cap (no estimate check; request.budgetBytes and request.threads are not
	// used here, the allocator carries the cap and `workers` the thread count).
	// Removes the output on any failure, before anything else. With workers, the context
	// is then freed, which lets every job already handed out finish (the running ones and
	// one queued: up to about two job durations, since zstd cannot cancel a job), unless
	// request.workerCleanup is abandon: then the context is left running for the process
	// exit to end, and the allocator must stay alive until then too.
	CompressOutcome encodeZstd(const ZstdPlan& plan, int workers, const CompressRequest& request, ProgressReporter& progress,
		BudgetAllocator& allocator);

	// The whole zstd run: plan, worker count, start line, then exit 70 when more than one
	// thread was requested from a libzstd without multithreading, exit 4 before the output is
	// created when the estimate plus the header allowance (fitsBudget) is over budget,
	// otherwise encodeZstd. With WorkerCleanup::abandon a failed multithreaded run leaks its
	// context and allocator on purpose, so the process can exit without waiting for the workers.
	CompressOutcome compressZstd(const CompressRequest& request, std::ostream& out);
}
