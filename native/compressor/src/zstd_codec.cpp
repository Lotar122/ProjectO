#include "projecto/zstd_codec.hpp"

#include <algorithm>
#include <array>
#include <format>
#include <memory>
#include <new>
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

		struct Setting
		{
			ZSTD_cParameter parameter;
			int value;
			std::string_view name;
		};

		// Applies every parameter of the plan; an error here is a bug, not a run-time condition.
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
				const std::size_t result = ZSTD_CCtxParams_setParameter(cctxParams, setting.parameter, setting.value);
				if (ZSTD_isError(result) != 0U)
				{
					throw std::logic_error(std::format("zstd {} {}: {}", setting.name, setting.value, ZSTD_getErrorName(result)));
				}
			}
		}

		CodecFailure libraryFailure(std::size_t code, const BudgetAllocator& allocator)
		{
			if (allocator.refused())
			{
				return CodecFailure{ExitCode::budget, std::format("zstd needs more memory than the budget of {} (peak {})",
					formatBytes(allocator.budget()), formatBytes(allocator.peak()))};
			}
			return CodecFailure{ExitCode::codec, std::format("zstd: {}", ZSTD_getErrorName(code))};
		}

		CodecFailure allocationFailure(const BudgetAllocator& allocator)
		{
			if (allocator.refused())
			{
				return libraryFailure(0, allocator);
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

		const CCtxParamsPtr cctxParams{ZSTD_createCCtxParams()};
		if (!cctxParams)
		{
			throw std::bad_alloc();
		}
		applyParams(cctxParams.get(), p);
		const std::size_t estimate = ZSTD_estimateCStreamSize_usingCCtxParams(cctxParams.get());
		if (ZSTD_isError(estimate) != 0U)
		{
			throw std::logic_error(std::format("zstd estimate: {}", ZSTD_getErrorName(estimate)));
		}
		plan.estimatedBytes = estimate;
		return plan;
	}

	JsonLine zstdStartLine(const ZstdPlan& plan, std::uint64_t budgetBytes)
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
			.number("estimatedBytes", plan.estimatedBytes)
			.number("budgetBytes", budgetBytes);
		return line;
	}

	CompressOutcome encodeZstd(const ZstdParams& params, const CompressRequest& request, ProgressReporter& progress,
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
		// the context, which holds every table, goes through the allocator.
		const CCtxParamsPtr cctxParams{ZSTD_createCCtxParams()};
		if (!cctxParams)
		{
			throw std::bad_alloc();
		}
		applyParams(cctxParams.get(), params);

		const CCtxPtr cctx{ZSTD_createCCtx_advanced(memory)};
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

		auto created = OutputFile::create(request.output);
		if (CodecFailure* failure = std::get_if<CodecFailure>(&created))
		{
			return std::move(*failure);
		}
		OutputFile& output = std::get<OutputFile>(created);
		Buffer outBuffer = makeIoBuffer();

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
				ZSTD_outBuffer out{outBuffer.data(), outBuffer.size(), 0};
				const std::size_t remaining = ZSTD_compressStream2(cctx.get(), &out, &in, mode);
				if (ZSTD_isError(remaining) != 0U)
				{
					return libraryFailure(remaining, allocator);
				}
				if (std::optional<CodecFailure> failure = output.write(std::span<const std::byte>{outBuffer}.first(out.pos)))
				{
					return std::move(*failure);
				}
				drained = last ? remaining == 0 : in.pos == in.size;
			}
			if (std::optional<CodecFailure> failure = progress.update(input.bytesRead(), output.written()))
			{
				return std::move(*failure);
			}
		}

		if (std::optional<CodecFailure> failure = output.commit())
		{
			return std::move(*failure);
		}
		return CompressStats{input.bytesRead(), output.written(), allocator.peak()};
	}

	CompressOutcome compressZstd(const CompressRequest& request, std::ostream& out)
	{
		const ZstdPlan plan = planZstd(request.inputSize, request.maxWindowLog);
		if (!writeLine(out, zstdStartLine(plan, request.budgetBytes)))
		{
			return CodecFailure{ExitCode::io, "cannot write to stdout"};
		}
		if (!fitsBudget(plan.estimatedBytes, request.budgetBytes))
		{
			return CodecFailure{ExitCode::budget, std::format("zstd level {} windowLog {} needs {} > budget {}",
				kZstdLevel, plan.params.windowLog, formatBytes(plan.estimatedBytes), formatBytes(request.budgetBytes))};
		}
		ProgressReporter progress{out, request.progressIntervalBytes};
		BudgetAllocator allocator{request.budgetBytes};
		return encodeZstd(plan.params, request, progress, allocator);
	}
}
