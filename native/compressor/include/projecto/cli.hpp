#pragma once

#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <variant>

namespace projecto
{
	enum class Codec
	{
		zstd,
		br,
	};

	// Numeric ranges of phase4.md section 7.1, as amended by phase4-amendments.md (A1, A3).
	inline constexpr std::uint64_t kMinInputSize = 1;
	inline constexpr std::uint64_t kMaxInputSize = std::uint64_t{1} << 30;

	inline constexpr std::uint64_t kMinMemoryBudgetMib = 64;
	inline constexpr std::uint64_t kMaxMemoryBudgetMib = 7168;
	inline constexpr std::uint64_t kDefaultMemoryBudgetMib = 6144;

	inline constexpr std::uint64_t kMinWindowLog = 10;
	inline constexpr std::uint64_t kMaxWindowLog = 28;
	inline constexpr std::uint64_t kDefaultMaxWindowLog = 28;

	inline constexpr std::uint64_t kMinProgressIntervalMib = 1;
	inline constexpr std::uint64_t kMaxProgressIntervalMib = 1024;
	inline constexpr std::uint64_t kDefaultProgressIntervalMib = 64;

	// zstd compression threads: 0 and 1 compress on the calling thread, 2 and more start
	// that many zstd workers (fewer when the input or the memory budget is too small).
	// Brotli is single-threaded and ignores the value. Same range as PROJECTO_ZSTD_THREADS
	// in nativeCompressor.js.
	inline constexpr std::uint64_t kMinThreads = 0;
	inline constexpr std::uint64_t kMaxThreads = 64;
	inline constexpr std::uint64_t kDefaultThreads = 4;

	// Syntactically valid arguments. Paths are only checked to be absolute here;
	// the file system rules live in paths.hpp.
	struct Options
	{
		Codec codec = Codec::zstd;
		std::filesystem::path root;
		std::filesystem::path input;
		std::filesystem::path output;
		std::uint64_t inputSize = 0;
		std::uint64_t memoryBudgetMib = kDefaultMemoryBudgetMib;
		std::uint64_t maxWindowLog = kDefaultMaxWindowLog;
		std::uint64_t progressIntervalMib = kDefaultProgressIntervalMib;
		std::uint64_t threads = kDefaultThreads;
		// --watch-stdin 1: exit (3) and remove the partial output as soon as stdin reaches end
		// of file, so the run stops when the parent that holds the other end of the pipe dies.
		bool watchStdin = false;
	};

	struct VersionRequest
	{
	};

	struct UsageError
	{
		std::string message;
	};

	using ParseResult = std::variant<VersionRequest, Options, UsageError>;

	// args excludes argv[0]. Accepts exactly `--version` or `compress <flags>`.
	// Each flag takes its value as the next token and may appear once.
	ParseResult parseOptions(std::span<const std::string_view> args);

	std::string_view codecName(Codec codec) noexcept;
}
