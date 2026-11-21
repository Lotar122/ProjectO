#include "projecto/brotli_codec.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <format>
#include <memory>
#include <ostream>
#include <stdexcept>
#include <string_view>
#include <utility>

#include <brotli/encode.h>

#include "projecto/budget_allocator.hpp"

namespace projecto
{
	namespace
	{
		struct StateDeleter
		{
			void operator()(BrotliEncoderState* state) const noexcept
			{
				BrotliEncoderDestroyInstance(state);
			}
		};

		using StatePtr = std::unique_ptr<BrotliEncoderState, StateDeleter>;

		struct Setting
		{
			BrotliEncoderParameter parameter;
			std::uint32_t value;
			std::string_view name;
		};

		// A recorded allocation failure explains the library error; taking it clears it, so it
		// is never blamed for a later error as well.
		CodecFailure libraryFailure(BudgetAllocator& allocator, std::string_view what)
		{
			switch (allocator.takeFailure())
			{
				case AllocationFailure::budget:
				{
					return CodecFailure{ExitCode::budget, std::format("brotli needs more memory than the budget of {} (peak {})",
						formatBytes(allocator.budget()), formatBytes(allocator.peak()))};
				}
				case AllocationFailure::system:
				{
					return CodecFailure{ExitCode::internal, std::format(
						"brotli: the system is out of memory (malloc failed within the budget of {}, peak {})",
						formatBytes(allocator.budget()), formatBytes(allocator.peak()))};
				}
				case AllocationFailure::none:
				{
					break;
				}
			}
			return CodecFailure{ExitCode::codec, std::format("brotli: {}", what)};
		}
	}

	BrotliPlan planBrotli(std::uint64_t size, std::uint64_t maxWindowLog)
	{
		const std::uint64_t cap = std::clamp(maxWindowLog, kMinWindowLog, kMaxWindowLog);
		BrotliPlan plan;
		plan.lgwin = static_cast<int>(windowLogFor(size, cap));
		// The large-window flag always writes the non-standard header, so it is only set
		// where the window needs it; streams up to 16 MiB stay RFC 7932.
		plan.largeWindow = plan.lgwin > kBrotliStandardMaxWindowLog;
		plan.sizeHint = static_cast<std::uint32_t>(std::min(size, kBrotliMaxSizeHint));
		const std::size_t estimate = BrotliEncoderEstimatePeakMemoryUsage(plan.quality, plan.lgwin, plan.sizeHint);
		if (estimate != 0)
		{
			plan.estimatedBytes = estimate;
		}
		return plan;
	}

	JsonLine brotliStartLine(const BrotliPlan& plan, std::uint64_t budgetBytes)
	{
		JsonLine line{"start"};
		line.text("codec", "br")
			.number("quality", static_cast<std::uint64_t>(plan.quality))
			.number("lgwin", static_cast<std::uint64_t>(plan.lgwin))
			.boolean("largeWindow", plan.largeWindow);
		if (plan.estimatedBytes)
		{
			line.number("estimatedBytes", *plan.estimatedBytes);
		}
		else
		{
			line.null("estimatedBytes");
		}
		line.number("budgetBytes", budgetBytes);
		return line;
	}

	CompressOutcome encodeBrotli(const BrotliPlan& plan, const CompressRequest& request, ProgressReporter& progress,
		BudgetAllocator& allocator)
	{
		auto opened = InputReader::open(request.input, request.inputSize);
		if (CodecFailure* failure = std::get_if<CodecFailure>(&opened))
		{
			return std::move(*failure);
		}
		InputReader& input = std::get<InputReader>(opened);

		const StatePtr state{BrotliEncoderCreateInstance(
			&BudgetAllocator::allocateThunk, &BudgetAllocator::deallocateThunk, &allocator)};
		if (!state)
		{
			return libraryFailure(allocator, "cannot create the encoder");
		}

		const std::array settings{
			Setting{BROTLI_PARAM_QUALITY, static_cast<std::uint32_t>(plan.quality), "quality"},
			Setting{BROTLI_PARAM_LGWIN, static_cast<std::uint32_t>(plan.lgwin), "lgwin"},
			Setting{BROTLI_PARAM_MODE, static_cast<std::uint32_t>(BROTLI_MODE_GENERIC), "mode"},
			Setting{BROTLI_PARAM_SIZE_HINT, plan.sizeHint, "size hint"},
			Setting{BROTLI_PARAM_LARGE_WINDOW, plan.largeWindow ? 1U : 0U, "large window"},
		};
		for (const Setting& setting : settings)
		{
			if (BrotliEncoderSetParameter(state.get(), setting.parameter, setting.value) == BROTLI_FALSE)
			{
				throw std::logic_error(std::format("brotli {} {} was rejected", setting.name, setting.value));
			}
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
			const BrotliEncoderOperation operation = last ? BROTLI_OPERATION_FINISH : BROTLI_OPERATION_PROCESS;
			std::size_t availableIn = data.size();
			const auto* nextIn = reinterpret_cast<const std::uint8_t*>(data.data());
			bool drained = false;
			while (!drained)
			{
				std::size_t availableOut = outBuffer.size();
				auto* nextOut = reinterpret_cast<std::uint8_t*>(outBuffer.data());
				if (BrotliEncoderCompressStream(state.get(), operation, &availableIn, &nextIn, &availableOut, &nextOut, nullptr)
					== BROTLI_FALSE)
				{
					return libraryFailure(allocator, "encoder failed");
				}
				const std::size_t produced = outBuffer.size() - availableOut;
				if (std::optional<CodecFailure> failure = output.write(std::span<const std::byte>{outBuffer}.first(produced)))
				{
					return std::move(*failure);
				}
				if (last)
				{
					drained = BrotliEncoderIsFinished(state.get()) == BROTLI_TRUE;
				}
				else
				{
					drained = availableIn == 0 && BrotliEncoderHasMoreOutput(state.get()) == BROTLI_FALSE;
				}
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
		return CompressStats{.inputSize = input.bytesRead(), .outputSize = output.written(), .peakBytes = allocator.peak()};
	}

	CompressOutcome compressBrotli(const CompressRequest& request, std::ostream& out)
	{
		const BrotliPlan plan = planBrotli(request.inputSize, request.maxWindowLog);
		if (!writeLine(out, brotliStartLine(plan, request.budgetBytes)))
		{
			return CodecFailure{ExitCode::io, "cannot write to stdout"};
		}
		if (plan.estimatedBytes && !fitsBudget(*plan.estimatedBytes, request.budgetBytes))
		{
			return CodecFailure{ExitCode::budget, std::format("brotli q{} lgwin {} needs {} > budget {}",
				plan.quality, plan.lgwin, formatBytes(*plan.estimatedBytes), formatBytes(request.budgetBytes))};
		}
		ProgressReporter progress{out, request.progressIntervalBytes};
		BudgetAllocator allocator{request.budgetBytes};
		return encodeBrotli(plan, request, progress, allocator);
	}
}
