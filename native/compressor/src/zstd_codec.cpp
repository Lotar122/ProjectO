#include "projecto/zstd_codec.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <format>
#include <memory>
#include <new>
#include <optional>
#include <ostream>
#include <stdexcept>
#include <string_view>
#include <utility>

#include <zstd.h>

#include "projecto/budget_allocator.hpp"

namespace projecto
{
	namespace
	{
		// zstd's level-22 LDM defaults for btultra2 (ZSTD_ldm_adjustParameters, 1.5.7).
		// Set explicitly: estimating with LDM on and these left at 0 divides by zero.
		constexpr int kLdmHashRateLog = 4;
		constexpr int kLdmMinMatch = 32;
		constexpr int kLdmMinHashLog = 6;
		constexpr int kLdmMaxBucketSizeLog = 8;

		// Sizes of zstd's own records in the MT formula (lib/compress/zstd_ldm.h, zstd_compress_internal.h
		// of 1.5.7): an LDM hash table entry is two U32, a raw LDM sequence three U32.
		constexpr std::uint64_t kLdmEntryBytes = 8;
		constexpr std::uint64_t kRawSeqBytes = 12;
		// zstdmt_compress.c: the input ring buffer keeps 3 jobs of slack when the overlap is not 0,
		// and the output buffer pool holds up to 2 * workers + 3 buffers.
		constexpr std::uint64_t kRingSlackJobs = 3;
		constexpr std::uint64_t kOutputBuffersPerWorker = 2;
		constexpr std::uint64_t kExtraOutputBuffers = 3;
		// Output taken per call with workers. ZSTD_compressStream2 with ZSTD_e_end only returns once
		// the frame is done or the output buffer is full, and with workers the whole input is
		// usually buffered before that call, so a 1 MiB buffer would hold the run there until the
		// end: no write (and so no write error) and no progress until then. A small window makes it
		// return after about every 512 KiB chunk a job compresses.
		constexpr std::size_t kWorkerOutputWindowBytes = std::size_t{16} << 10;

		struct CCtxDeleter
		{
			void operator()(ZSTD_CCtx* cctx) const noexcept
			{
				ZSTD_freeCCtx(cctx);
			}
		};

		struct CCtxParamsDeleter
		{
			void operator()(ZSTD_CCtx_params* params) const noexcept
			{
				ZSTD_freeCCtxParams(params);
			}
		};

		using CCtxPtr = std::unique_ptr<ZSTD_CCtx, CCtxDeleter>;
		using CCtxParamsPtr = std::unique_ptr<ZSTD_CCtx_params, CCtxParamsDeleter>;

		// A failed multithreaded run's context and allocator under WorkerCleanup::abandon: still in
		// use by the workers until the process exits, so they are kept reachable here instead of
		// being dropped (a leak checker would otherwise report them). A process runs one compression.
		std::atomic<ZSTD_CCtx*> gAbandonedContext = nullptr;
		std::atomic<BudgetAllocator*> gAbandonedAllocator = nullptr;

		struct Setting
		{
			ZSTD_cParameter parameter;
			int value;
			std::string_view name;
		};

		// Applies one parameter and returns the value zstd stored (it clamps some silently).
		// An error here is a bug, not a run-time condition.
		std::size_t applySetting(ZSTD_CCtx_params* cctxParams, const Setting& setting)
		{
			const std::size_t result = ZSTD_CCtxParams_setParameter(cctxParams, setting.parameter, setting.value);
			if (ZSTD_isError(result) != 0U)
			{
				throw std::logic_error(std::format("zstd {} {}: {}", setting.name, setting.value, ZSTD_getErrorName(result)));
			}
			return result;
		}

		// Applies every parameter of the plan.
		void applyParams(ZSTD_CCtx_params* cctxParams, const ZstdParams& p)
		{
			const std::size_t init = ZSTD_CCtxParams_init(cctxParams, kZstdLevel);
			if (ZSTD_isError(init) != 0U)
			{
				throw std::logic_error(std::format("zstd params init: {}", ZSTD_getErrorName(init)));
			}
			const std::array settings{
				Setting{ZSTD_c_windowLog, p.windowLog, "windowLog"},
				Setting{ZSTD_c_chainLog, p.chainLog, "chainLog"},
				Setting{ZSTD_c_hashLog, p.hashLog, "hashLog"},
				Setting{ZSTD_c_searchLog, p.searchLog, "searchLog"},
				Setting{ZSTD_c_minMatch, p.minMatch, "minMatch"},
				Setting{ZSTD_c_targetLength, p.targetLength, "targetLength"},
				Setting{ZSTD_c_strategy, p.strategy, "strategy"},
				Setting{ZSTD_c_enableLongDistanceMatching, static_cast<int>(ZSTD_ps_enable), "enableLongDistanceMatching"},
				Setting{ZSTD_c_ldmHashLog, p.ldmHashLog, "ldmHashLog"},
				Setting{ZSTD_c_ldmMinMatch, p.ldmMinMatch, "ldmMinMatch"},
				Setting{ZSTD_c_ldmBucketSizeLog, p.ldmBucketSizeLog, "ldmBucketSizeLog"},
				Setting{ZSTD_c_ldmHashRateLog, p.ldmHashRateLog, "ldmHashRateLog"},
				Setting{ZSTD_c_checksumFlag, 1, "checksumFlag"},
				Setting{ZSTD_c_contentSizeFlag, 1, "contentSizeFlag"},
			};
			for (const Setting& setting : settings)
			{
				applySetting(cctxParams, setting);
			}
		}

		// The multithreading parameters; workers 0 leaves the run single-threaded. zstd clamps
		// nbWorkers to its bounds without an error, so the stored value is checked as well.
		void applyThreading(ZSTD_CCtx_params* cctxParams, const ZstdJobs& jobs, int workers)
		{
			if (workers == 0)
			{
				return;
			}
			const std::size_t stored = applySetting(cctxParams, Setting{ZSTD_c_nbWorkers, workers, "nbWorkers"});
			if (stored != static_cast<std::size_t>(workers))
			{
				throw std::logic_error(std::format("zstd nbWorkers {}: the library kept {}", workers, stored));
			}
			applySetting(cctxParams, Setting{ZSTD_c_jobSize, static_cast<int>(jobs.jobSize), "jobSize"});
			applySetting(cctxParams, Setting{ZSTD_c_overlapLog, jobs.overlapLog, "overlapLog"});
		}

		ZstdJobs planJobs(std::uint64_t size, int windowLog)
		{
			const std::uint64_t window = std::uint64_t{1} << windowLog;
			const std::uint64_t jobSize = std::clamp(window >> 3U, kZstdMinJobBytes, kZstdMaxJobBytes);
			// overlap = window >> (9 - overlapLog), so overlap == jobSize needs 9 - log2(window / jobSize).
			// A window below 2 jobs only ever makes one job; the clamp keeps the value valid there.
			const int windowOverJobLog = windowLog - std::countr_zero(jobSize);
			ZstdJobs jobs;
			jobs.jobSize = jobSize;
			jobs.overlapLog = std::clamp(9 - windowOverJobLog, 1, 9);
			jobs.count = (size + jobSize - 1) / jobSize;
			return jobs;
		}

		std::uint64_t checkedEstimate(std::size_t estimate, std::string_view what)
		{
			if (ZSTD_isError(estimate) != 0U)
			{
				throw std::logic_error(std::format("zstd {} estimate: {}", what, ZSTD_getErrorName(estimate)));
			}
			return estimate;
		}

		// An allocation failure recorded by the allocator explains the library error; it is
		// taken (cleared) here so it is never blamed for a later error as well.
		std::optional<CodecFailure> allocatorFailure(BudgetAllocator& allocator)
		{
			switch (allocator.takeFailure())
			{
				case AllocationFailure::budget:
				{
					return CodecFailure{ExitCode::budget, std::format("zstd needs more memory than the budget of {} (peak {})",
						formatBytes(allocator.budget()), formatBytes(allocator.peak()))};
				}
				case AllocationFailure::system:
				{
					return CodecFailure{ExitCode::internal, std::format(
						"zstd: the system is out of memory (malloc failed within the budget of {}, peak {})",
						formatBytes(allocator.budget()), formatBytes(allocator.peak()))};
				}
				case AllocationFailure::none:
				{
					break;
				}
			}
			return std::nullopt;
		}

		CodecFailure libraryFailure(std::size_t code, BudgetAllocator& allocator)
		{
			if (std::optional<CodecFailure> failure = allocatorFailure(allocator))
			{
				return std::move(*failure);
			}
			return CodecFailure{ExitCode::codec, std::format("zstd: {}", ZSTD_getErrorName(code))};
		}

		CodecFailure allocationFailure(BudgetAllocator& allocator)
		{
			if (std::optional<CodecFailure> failure = allocatorFailure(allocator))
			{
				return std::move(*failure);
			}
			return CodecFailure{ExitCode::internal, "zstd: cannot create the compression context"};
		}
	}

	ZstdPlan planZstd(std::uint64_t size, std::uint64_t maxWindowLog)
	{
		const std::uint64_t cap = std::clamp(maxWindowLog, kMinWindowLog, kMaxWindowLog);
		ZSTD_compressionParameters cp = ZSTD_getCParams(kZstdLevel, size, 0);
		cp.windowLog = static_cast<unsigned>(windowLogFor(size, cap));
		cp = ZSTD_adjustCParams(cp, size, 0);
		// The bt matcher reaches 2^(chainLog - 1) positions back: let it cover the whole window.
		cp.chainLog = cp.windowLog + 1;

		ZstdPlan plan;
		ZstdParams& p = plan.params;
		p.windowLog = static_cast<int>(cp.windowLog);
		p.chainLog = static_cast<int>(cp.chainLog);
		p.hashLog = static_cast<int>(cp.hashLog);
		p.searchLog = static_cast<int>(cp.searchLog);
		p.minMatch = static_cast<int>(cp.minMatch);
		p.targetLength = static_cast<int>(cp.targetLength);
		p.strategy = static_cast<int>(cp.strategy);
		p.ldmHashLog = std::max(kLdmMinHashLog, p.windowLog - kLdmHashRateLog);
		p.ldmMinMatch = kLdmMinMatch;
		p.ldmBucketSizeLog = std::min(kLdmMaxBucketSizeLog, p.ldmHashLog);
		p.ldmHashRateLog = kLdmHashRateLog;
		plan.jobs = planJobs(size, p.windowLog);

		const CCtxParamsPtr cctxParams{ZSTD_createCCtxParams()};
		if (!cctxParams)
		{
			throw std::bad_alloc();
		}
		applyParams(cctxParams.get(), p);
		plan.estimatedBytes = checkedEstimate(ZSTD_estimateCStreamSize_usingCCtxParams(cctxParams.get()), "stream");
		// A worker's context: zstdmt turns LDM off for each job and hands it the sequences of
		// the shared LDM pass instead, and a job context has no stream buffers.
		applySetting(cctxParams.get(), Setting{ZSTD_c_enableLongDistanceMatching, static_cast<int>(ZSTD_ps_disable),
			"enableLongDistanceMatching"});
		plan.workerContextBytes = checkedEstimate(ZSTD_estimateCCtxSize_usingCCtxParams(cctxParams.get()), "worker context");
		return plan;
	}

	std::uint64_t zstdEstimate(const ZstdPlan& plan, int workers)
	{
		if (workers <= 0)
		{
			return plan.estimatedBytes;
		}
		const ZstdParams& p = plan.params;
		const std::uint64_t n = static_cast<std::uint64_t>(workers);
		const std::uint64_t window = std::uint64_t{1} << p.windowLog;
		const std::uint64_t job = plan.jobs.jobSize;

		const std::uint64_t contexts = n * (plan.workerContextBytes + kZstdMtPerWorkerBytes);
		const std::uint64_t ring = std::max(window, n * job) + kRingSlackJobs * job;
		const std::uint64_t outputs = (kOutputBuffersPerWorker * n + kExtraOutputBuffers)
			* static_cast<std::uint64_t>(ZSTD_compressBound(static_cast<std::size_t>(job)));
		const std::uint64_t ldmTables = (std::uint64_t{1} << p.ldmHashLog) * kLdmEntryBytes
			+ (std::uint64_t{1} << (p.ldmHashLog - p.ldmBucketSizeLog));
		const std::uint64_t ldmSequences = n * (job / static_cast<std::uint64_t>(p.ldmMinMatch)) * kRawSeqBytes;
		return contexts + ring + outputs + ldmTables + ldmSequences + kZstdMtFixedBytes;
	}

	ZstdThreading chooseZstdThreading(const ZstdPlan& plan, std::uint64_t requestedThreads, std::uint64_t budgetBytes)
	{
		ZstdThreading threading;
		threading.requested = requestedThreads;
		const std::uint64_t useful = std::min({requestedThreads, plan.jobs.count, kMaxThreads});
		for (std::uint64_t workers = useful; workers >= 2; --workers)
		{
			const std::uint64_t estimate = zstdEstimate(plan, static_cast<int>(workers));
			if (fitsBudget(estimate, budgetBytes))
			{
				threading.workers = static_cast<int>(workers);
				threading.estimatedBytes = estimate;
				return threading;
			}
		}
		threading.workers = 0;
		threading.estimatedBytes = plan.estimatedBytes;
		return threading;
	}

	bool zstdSupportsThreads() noexcept
	{
		const ZSTD_bounds bounds = ZSTD_cParam_getBounds(ZSTD_c_nbWorkers);
		return ZSTD_isError(bounds.error) == 0U && bounds.upperBound >= static_cast<int>(kMaxThreads);
	}

	JsonLine zstdStartLine(const ZstdPlan& plan, const ZstdThreading& threading, std::uint64_t budgetBytes)
	{
		const ZstdParams& p = plan.params;
		const auto number = [](int value)
		{
			return static_cast<std::uint64_t>(value);
		};
		JsonLine line{"start"};
		line.text("codec", "zstd")
			.number("level", number(kZstdLevel))
			.number("windowLog", number(p.windowLog))
			.number("chainLog", number(p.chainLog))
			.number("hashLog", number(p.hashLog))
			.number("searchLog", number(p.searchLog))
			.number("minMatch", number(p.minMatch))
			.number("targetLength", number(p.targetLength))
			.number("strategy", number(p.strategy))
			.boolean("ldm", true)
			.number("ldmHashLog", number(p.ldmHashLog))
			.number("ldmMinMatch", number(p.ldmMinMatch))
			.number("ldmBucketSizeLog", number(p.ldmBucketSizeLog))
			.number("ldmHashRateLog", number(p.ldmHashRateLog))
			.number("threads", threading.requested)
			.number("workers", number(threading.workers))
			.number("jobSize", plan.jobs.jobSize)
			.number("overlapLog", number(plan.jobs.overlapLog))
			.number("estimatedBytes", threading.estimatedBytes)
			.number("budgetBytes", budgetBytes);
		return line;
	}

	namespace
	{
		// The streaming part of encodeZstd: owns the output, so every return removes the partial
		// output (or keeps the committed one) before the caller decides what to do with the context.
		CompressOutcome streamZstd(ZSTD_CCtx* cctx, int appliedWorkers, const CompressRequest& request, InputReader& input,
			ProgressReporter& progress, BudgetAllocator& allocator)
		{
			auto created = OutputFile::create(request.output);
			if (CodecFailure* failure = std::get_if<CodecFailure>(&created))
			{
				return std::move(*failure);
			}
			OutputFile& output = std::get<OutputFile>(created);
			Buffer outBuffer = makeIoBuffer();
			const bool threaded = appliedWorkers > 0;
			const std::size_t window = threaded ? std::min(kWorkerOutputWindowBytes, outBuffer.size()) : outBuffer.size();
			std::uint64_t peakActiveWorkers = 0;

			bool last = false;
			while (!last)
			{
				auto chunk = input.next();
				if (CodecFailure* failure = std::get_if<CodecFailure>(&chunk))
				{
					return std::move(*failure);
				}
				const std::span<const std::byte> data = std::get<std::span<const std::byte>>(chunk);
				last = data.empty();
				const ZSTD_EndDirective mode = last ? ZSTD_e_end : ZSTD_e_continue;
				ZSTD_inBuffer in{data.data(), data.size(), 0};
				bool drained = false;
				while (!drained)
				{
					// With workers, a call hands input to the jobs and copies out what the oldest job
					// has produced so far; it blocks only while there is no room for more input (or,
					// at the end, nothing new to copy), until that job produces more.
					ZSTD_outBuffer out{outBuffer.data(), window, 0};
					const std::size_t remaining = ZSTD_compressStream2(cctx, &out, &in, mode);
					if (ZSTD_isError(remaining) != 0U)
					{
						return libraryFailure(remaining, allocator);
					}
					if (std::optional<CodecFailure> failure = output.write(std::span<const std::byte>{outBuffer}.first(out.pos)))
					{
						return std::move(*failure);
					}
					drained = last ? remaining == 0 : in.pos == in.size;
					if (threaded)
					{
						// The input is read far ahead of the jobs (up to a window), so progress counts
						// the bytes the jobs have compressed, not the bytes read.
						const ZSTD_frameProgression state = ZSTD_getFrameProgression(cctx);
						peakActiveWorkers = std::max<std::uint64_t>(peakActiveWorkers, state.nbActiveWorkers);
						if (std::optional<CodecFailure> failure = progress.update(state.consumed, output.written()))
						{
							return std::move(*failure);
						}
					}
				}
				if (!threaded)
				{
					if (std::optional<CodecFailure> failure = progress.update(input.bytesRead(), output.written()))
					{
						return std::move(*failure);
					}
				}
			}

			if (std::optional<CodecFailure> failure = output.commit())
			{
				return std::move(*failure);
			}
			CompressStats stats;
			stats.inputSize = input.bytesRead();
			stats.outputSize = output.written();
			stats.peakBytes = allocator.peak();
			stats.workers = static_cast<std::uint64_t>(appliedWorkers);
			stats.peakActiveWorkers = peakActiveWorkers;
			return stats;
		}
	}

	CompressOutcome encodeZstd(const ZstdPlan& plan, int workers, const CompressRequest& request, ProgressReporter& progress,
		BudgetAllocator& allocator)
	{
		auto opened = InputReader::open(request.input, request.inputSize);
		if (CodecFailure* failure = std::get_if<CodecFailure>(&opened))
		{
			return std::move(*failure);
		}
		InputReader& input = std::get<InputReader>(opened);

		const ZSTD_customMem memory{&BudgetAllocator::allocateThunk, &BudgetAllocator::deallocateThunk, &allocator};

		// A parameter set is a few hundred bytes and has no custom-allocator constructor;
		// the context, which holds every table, goes through the allocator, and so does
		// everything the worker threads allocate.
		const CCtxParamsPtr cctxParams{ZSTD_createCCtxParams()};
		if (!cctxParams)
		{
			throw std::bad_alloc();
		}
		applyParams(cctxParams.get(), plan.params);
		applyThreading(cctxParams.get(), plan.jobs, workers);

		CCtxPtr cctx{ZSTD_createCCtx_advanced(memory)};
		if (!cctx)
		{
			return allocationFailure(allocator);
		}
		std::size_t status = ZSTD_CCtx_setParametersUsingCCtxParams(cctx.get(), cctxParams.get());
		if (ZSTD_isError(status) != 0U)
		{
			return libraryFailure(status, allocator);
		}
		status = ZSTD_CCtx_setPledgedSrcSize(cctx.get(), request.inputSize);
		if (ZSTD_isError(status) != 0U)
		{
			return libraryFailure(status, allocator);
		}
		int appliedWorkers = 0;
		status = ZSTD_CCtx_getParameter(cctx.get(), ZSTD_c_nbWorkers, &appliedWorkers);
		if (ZSTD_isError(status) != 0U || appliedWorkers != workers)
		{
			return CodecFailure{ExitCode::internal, std::format("zstd: asked for {} workers, the context has {}", workers,
				appliedWorkers)};
		}

		// The partial output is gone once streamZstd returns. Freeing the context then lets the
		// jobs already handed to the workers run to the end (zstd cannot cancel a job): with
		// WorkerCleanup::abandon the context is left to the process exit instead.
		CompressOutcome outcome = streamZstd(cctx.get(), appliedWorkers, request, input, progress, allocator);
		if (workers > 0 && request.workerCleanup == WorkerCleanup::abandon && std::holds_alternative<CodecFailure>(outcome))
		{
			gAbandonedContext.store(cctx.release());
		}
		return outcome;
	}

	CompressOutcome compressZstd(const CompressRequest& request, std::ostream& out)
	{
		const ZstdPlan plan = planZstd(request.inputSize, request.maxWindowLog);
		// zstd refuses nbWorkers > 0 when it was built without ZSTD_MULTITHREAD. That is a broken
		// build, so it fails every run that asked for threads, not just the large ones.
		if (request.threads >= 2 && !zstdSupportsThreads())
		{
			return CodecFailure{ExitCode::internal, std::format(
				"zstd was built without multithreading (ZSTD_MULTITHREAD), so --threads {} cannot be honoured; "
				"rebuild it with ZSTD_MULTITHREAD_SUPPORT or pass --threads 1", request.threads)};
		}
		const ZstdThreading threading = chooseZstdThreading(plan, request.threads, request.budgetBytes);
		if (!writeLine(out, zstdStartLine(plan, threading, request.budgetBytes)))
		{
			return CodecFailure{ExitCode::io, "cannot write to stdout"};
		}
		if (!fitsBudget(threading.estimatedBytes, request.budgetBytes))
		{
			return CodecFailure{ExitCode::budget, std::format("zstd level {} windowLog {} needs {} > budget {}",
				kZstdLevel, plan.params.windowLog, formatBytes(threading.estimatedBytes), formatBytes(request.budgetBytes))};
		}
		ProgressReporter progress{out, request.progressIntervalBytes};
		auto allocator = std::make_unique<BudgetAllocator>(request.budgetBytes);
		CompressOutcome outcome = encodeZstd(plan, threading.workers, request, progress, *allocator);
		// An abandoned context still has workers that allocate and free through the allocator.
		if (threading.workers > 0 && request.workerCleanup == WorkerCleanup::abandon
			&& std::holds_alternative<CodecFailure>(outcome))
		{
			gAbandonedAllocator.store(allocator.release());
		}
		return outcome;
	}
}
