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

	// One compress run, with validated canonical paths.
	struct CompressRequest
	{
		std::filesystem::path input;
		std::filesystem::path output;
		std::uint64_t inputSize = 0;
		std::uint64_t budgetBytes = kDefaultMemoryBudgetMib * kMiB;
		std::uint64_t maxWindowLog = kDefaultMaxWindowLog;
		std::uint64_t progressIntervalBytes = kDefaultProgressIntervalMib * kMiB;
	};

	struct CompressStats
	{
		std::uint64_t inputSize = 0;
		std::uint64_t outputSize = 0;
		std::uint64_t peakBytes = 0;
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
	// pass another multiple of the interval.
	class ProgressReporter
	{
	public:
		// Called after every chunk with (bytes read, bytes written); lets tests act mid-run.
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
	// longer or shorter than the size it was validated with.
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
	// A file that could not be created is never touched.
	class OutputFile
	{
	public:
		static std::variant<OutputFile, CodecFailure> create(const std::filesystem::path& path);

		OutputFile(OutputFile&& other) noexcept;
		OutputFile& operator=(OutputFile&&) = delete;
		OutputFile(const OutputFile&) = delete;
		OutputFile& operator=(const OutputFile&) = delete;
		~OutputFile();

		std::optional<CodecFailure> write(std::span<const std::byte> data);
		// Flushes and closes. The file is kept only when this succeeds.
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
