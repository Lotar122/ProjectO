#pragma once

#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <iosfwd>
#include <optional>
#include <span>
#include <string>
#include <variant>

#include "projecto/cli.hpp"
#include "projecto/exit_code.hpp"
#include "projecto/file_io.hpp"

namespace projecto
{
	inline constexpr std::uint64_t kMiB = std::uint64_t{1} << 20;

	// Window sized to the file: ceil(log2(size)) within [kMinWindowLog, maxWindowLog].
	// Same function and vectors as windowLogFor in fileCompression.js.
	constexpr std::uint64_t windowLogFor(std::uint64_t size, std::uint64_t maxWindowLog) noexcept
	{
		const std::uint64_t needed = size > 1 ? static_cast<std::uint64_t>(std::bit_width(size - 1)) : kMinWindowLog;
		return std::min(std::max(needed, kMinWindowLog), maxWindowLog);
	}

	// What a failed multithreaded zstd run does with the jobs its workers are still running
	// (zstd cannot cancel a job; freeing the context lets every handed-out job finish).
	enum class WorkerCleanup
	{
		// Free the context and wait for those jobs: for callers that live on (tests).
		wait,
		// Leave the context, its workers and their allocator alive and let the process exit end
		// them: the binary, which exits right after reporting the failure.
		abandon,
	};

	// One compress run, with validated canonical paths.
	struct CompressRequest
	{
		std::filesystem::path input;
		std::filesystem::path output;
		std::uint64_t inputSize = 0;
		std::uint64_t budgetBytes = kDefaultMemoryBudgetMib * kMiB;
		std::uint64_t maxWindowLog = kDefaultMaxWindowLog;
		std::uint64_t progressIntervalBytes = kDefaultProgressIntervalMib * kMiB;
		// Requested zstd threads (--threads); brotli ignores it.
		std::uint64_t threads = kDefaultThreads;
		WorkerCleanup workerCleanup = WorkerCleanup::wait;
	};

	struct CompressStats
	{
		std::uint64_t inputSize = 0;
		std::uint64_t outputSize = 0;
		std::uint64_t peakBytes = 0;
		// zstd's nbWorkers as read back from the context after the run (0: single-threaded, and
		// always 0 for brotli).
		std::uint64_t workers = 0;
		// Most zstd jobs in flight at once (running, queued, or cut and waiting for a worker),
		// sampled after each input chunk with ZSTD_getFrameProgression. zstd reports it in MT
		// mode only, so it stays 0 single-threaded.
		std::uint64_t peakActiveWorkers = 0;
	};

	struct CodecFailure
	{
		ExitCode code = ExitCode::internal;
		std::string message;
	};

	using CompressOutcome = std::variant<CompressStats, CodecFailure>;

	// "141.5 MiB" below 1 GiB, "2.5 GiB" from there on.
	std::string formatBytes(std::uint64_t bytes);

	// Writes {"type":"progress","read":...,"written":...} each time the bytes read
	// pass another multiple of the interval. With zstd workers "read" is the input the
	// jobs have compressed so far (the file itself is read up to a window ahead of them).
	class ProgressReporter
	{
	public:
		// Called after every update (each input chunk; with zstd workers each output step) with
		// (bytes read, bytes written); lets tests act mid-run.
		using Listener = std::function<void(std::uint64_t, std::uint64_t)>;

		ProgressReporter(std::ostream& out, std::uint64_t intervalBytes, Listener listener = {});

		// Fails (exit 3) when stdout cannot be written.
		std::optional<CodecFailure> update(std::uint64_t bytesRead, std::uint64_t bytesWritten);

	private:
		std::ostream& out_;
		std::uint64_t interval_;
		std::uint64_t next_;
		Listener listener_;
	};

	// Reads the input in 1 MiB chunks and fails as soon as the file turns out
	// longer or shorter than the size it was validated with. open() checks the open
	// handle itself: a regular file with one link and the expected size.
	class InputReader
	{
	public:
		static std::variant<InputReader, CodecFailure> open(const std::filesystem::path& path, std::uint64_t expectedSize);

		// The next chunk, or an empty span at the end of the input.
		std::variant<std::span<const std::byte>, CodecFailure> next();

		std::uint64_t bytesRead() const noexcept
		{
			return read_;
		}

	private:
		InputReader(File file, std::uint64_t expectedSize);

		File file_;
		Buffer buffer_;
		std::uint64_t expected_ = 0;
		std::uint64_t read_ = 0;
	};

	// Exclusive-create output that removes itself unless commit() succeeded,
	// so every failure path (error return or exception) leaves no partial file.
	// A file that could not be created is never touched. Until commit() the path is
	// listed in PendingOutputs, so a shutdown on another thread can remove it too.
	class OutputFile
	{
	public:
		static std::variant<OutputFile, CodecFailure> create(const std::filesystem::path& path);

		OutputFile(OutputFile&& other) noexcept;
		OutputFile& operator=(OutputFile&&) = delete;
		OutputFile(const OutputFile&) = delete;
		OutputFile& operator=(const OutputFile&) = delete;
		// Removes the file unless it was committed. Never throws.
		~OutputFile();

		std::optional<CodecFailure> write(std::span<const std::byte> data);
		// Flushes, syncs to stable storage and closes. The file is kept only when this succeeds,
		// and success also marks the run finished (PendingOutputs::markFinished), in the same
		// lock hold that unregisters the path: the run has one output, so it is decided here.
		std::optional<CodecFailure> commit();

		std::uint64_t written() const noexcept
		{
			return written_;
		}

	private:
		OutputFile(File file, std::filesystem::path path);

		File file_;
		std::filesystem::path path_;
		std::uint64_t written_ = 0;
		bool owned_ = true;
	};
}
