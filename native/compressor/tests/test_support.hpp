#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "projecto/exit_code.hpp"

namespace projecto::testing
{
	using Bytes = std::vector<std::byte>;

	// Seeded generators; the same seed gives the same bytes on every platform
	// (integer hashing and raw std::mt19937_64 output, little-endian floats written byte by byte).

	// Binary STL: an 80-byte header, a triangle count, then 50-byte triangles over a
	// gently noisy height field, so vertices repeat across neighbouring triangles.
	Bytes stlLike(std::size_t size, std::uint64_t seed);
	Bytes randomBytes(std::size_t size, std::uint64_t seed);
	// ASCII lines like an ASCII STL.
	Bytes textLike(std::size_t size);

	void writeBytes(const std::filesystem::path& path, std::span<const std::byte> data);
	Bytes readBytes(const std::filesystem::path& path);

	// Decoders, linked into the test binary only. windowLogMax 0 keeps libzstd's default
	// limit (27). Both return nothing when the stream is rejected or truncated.
	std::optional<Bytes> decodeZstd(std::span<const std::byte> frame, int windowLogMax);
	std::optional<Bytes> decodeBrotli(std::span<const std::byte> stream, bool largeWindow);

	struct AppRun
	{
		ExitCode code = ExitCode::internal;
		std::string out;
		std::string err;
	};

	AppRun runCompressor(const std::vector<std::string>& args);

	// Arguments for `compress` with in/out files under root.
	std::vector<std::string> compressArgs(std::string_view codec, const std::filesystem::path& root,
		std::string_view inputName, std::string_view outputName, std::uint64_t inputSize);

	std::vector<std::string> splitLines(std::string_view text);
	// The line whose "type" is `type`; the last one when there are several.
	std::optional<std::string> lineOfType(std::string_view out, std::string_view type);
	std::optional<std::uint64_t> numberField(std::string_view line, std::string_view key);
	std::optional<std::string> textField(std::string_view line, std::string_view key);

	// True when PROJECTO_LARGE_TESTS=1. Otherwise prints the marker that ctest
	// turns into SKIPPED (SKIP_REGULAR_EXPRESSION in CMakeLists.txt).
	bool largeTestsEnabled();
}
