#include "projecto/app.hpp"

#include <chrono>
#include <ostream>
#include <string>
#include <variant>

#include "projecto/brotli_codec.hpp"
#include "projecto/cli.hpp"
#include "projecto/codec_common.hpp"
#include "projecto/file_io.hpp"
#include "projecto/paths.hpp"
#include "projecto/protocol.hpp"
#include "projecto/version.hpp"
#include "projecto/zstd_codec.hpp"

namespace projecto
{
	namespace
	{
		ExitCode fail(std::ostream& out, std::ostream& err, ExitCode code, const std::string& message,
			bool writeResult = true)
		{
			// The exit code carries the failure even when stdout is gone.
			if (writeResult)
			{
				static_cast<void>(writeLine(out, errorResult(code, message)));
			}
			err << "projecto-compress: " << message << '\n';
			return code;
		}

		// "projecto-compress/1.0.0 zstd/1.5.7" or "projecto-compress/1.0.0 brotli/1.2.1"
		std::string encoderName(Codec codec)
		{
			std::string name = "projecto-compress/" + projectVersion();
			name += codec == Codec::zstd ? " zstd/" + zstdVersion() : " brotli/" + brotliVersion();
			return name;
		}

		ExitCode compress(const Options& options, const ValidatedPaths& paths, std::ostream& out, std::ostream& err,
			WorkerCleanup workerCleanup)
		{
			const auto started = std::chrono::steady_clock::now();
			CompressRequest request;
			request.input = paths.input;
			request.output = paths.output;
			request.inputSize = options.inputSize;
			request.budgetBytes = options.memoryBudgetMib * kMiB;
			request.maxWindowLog = options.maxWindowLog;
			request.progressIntervalBytes = options.progressIntervalMib * kMiB;
			request.threads = options.threads;
			request.workerCleanup = workerCleanup;

			// Each codec removes its own output on every failure path.
			CompressOutcome outcome = options.codec == Codec::zstd ? compressZstd(request, out) : compressBrotli(request, out);
			if (const CodecFailure* failure = std::get_if<CodecFailure>(&outcome))
			{
				return fail(out, err, failure->code, failure->message);
			}

			// The output is committed, so the outcome is decided: OutputFile::commit() already
			// marked the run finished, so a closed stdin (--watch-stdin) cannot turn it into exit 3.
			const CompressStats& stats = std::get<CompressStats>(outcome);
			const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started);
			JsonLine result{"result"};
			result.boolean("ok", true)
				.text("codec", codecName(options.codec))
				.number("inputSize", stats.inputSize)
				.number("outputSize", stats.outputSize)
				.number("peakBytes", stats.peakBytes)
				.number("workers", stats.workers)
				.number("elapsedMs", static_cast<std::uint64_t>(elapsed.count()))
				.text("encoder", encoderName(options.codec));
			if (!writeLine(out, result))
			{
				// The output is complete and on stable storage, so it is kept: removing a good
				// file gains nothing, and a caller that still has the exit code and stderr can
				// decide. The exit code stays 3, because the result line is part of the contract;
				// a caller that does not use the file removes it with the rest of its temp files.
				// stdout just refused the success line, so a second (error) result line is not tried.
				return fail(out, err, ExitCode::io,
					"cannot write the result line to stdout; the complete output was kept at " + paths.output.string(), false);
			}
			return ExitCode::ok;
		}
	}

	ExitCode runApp(std::span<const std::string_view> args, std::ostream& out, std::ostream& err,
		const StdinWatchStarter& startStdinWatch, WorkerCleanup workerCleanup)
	{
		const ParseResult parsed = parseOptions(args);
		if (const UsageError* usage = std::get_if<UsageError>(&parsed))
		{
			return fail(out, err, ExitCode::usage, usage->message);
		}
		if (const Options* options = std::get_if<Options>(&parsed); options != nullptr && options->watchStdin)
		{
			if (!startStdinWatch)
			{
				return fail(out, err, ExitCode::internal, "--watch-stdin is not available in this build");
			}
			if (const std::optional<std::string> problem = startStdinWatch())
			{
				return fail(out, err, ExitCode::internal, *problem);
			}
		}
		if (const std::optional<std::string> mismatch = checkLibraryVersions())
		{
			return fail(out, err, ExitCode::internal, *mismatch);
		}
		if (std::holds_alternative<VersionRequest>(parsed))
		{
			if (!writeLine(out, versionLine()))
			{
				err << "projecto-compress: cannot write to stdout\n";
				return ExitCode::io;
			}
			return ExitCode::ok;
		}

		const Options& options = std::get<Options>(parsed);
		const auto paths = validatePaths(options);
		if (const PathError* error = std::get_if<PathError>(&paths))
		{
			return fail(out, err, error->code, error->message);
		}
		return compress(options, std::get<ValidatedPaths>(paths), out, err, workerCleanup);
	}
}
