#include "test_support.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string_view>

#include <brotli/decode.h>
#include <zstd.h>

#include "projecto/app.hpp"

namespace projecto::testing
{
	namespace fs = std::filesystem;

	namespace
	{
		constexpr std::size_t kStlHeaderBytes = 84;
		constexpr std::size_t kStlTriangleBytes = 50;
		constexpr std::uint32_t kStlColumns = 512;

		std::uint64_t mix(std::uint64_t value) noexcept
		{
			value += 0x9E3779B97F4A7C15ULL;
			value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
			value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
			return value ^ (value >> 31U);
		}

		void putU32(Bytes& out, std::uint32_t value)
		{
			for (unsigned shift = 0; shift < 32U; shift += 8U)
			{
				out.push_back(static_cast<std::byte>((value >> shift) & 0xFFU));
			}
		}

		void putFloat(Bytes& out, float value)
		{
			putU32(out, std::bit_cast<std::uint32_t>(value));
		}

		// Integer height field: smooth slope plus a little seeded roughness. Integer maths
		// and power-of-two scaling keep every float exact and identical on all platforms.
		std::int32_t height(std::uint32_t x, std::uint32_t y, std::uint64_t seed) noexcept
		{
			const std::int32_t slope = static_cast<std::int32_t>((x * x / 64U + y * 3U) % 8192U);
			const std::int32_t rough = static_cast<std::int32_t>(mix(seed ^ (std::uint64_t{x} << 32U) ^ y) & 0x1FU);
			return slope + rough;
		}

		void putVertex(Bytes& out, std::uint32_t x, std::uint32_t y, std::uint64_t seed)
		{
			putFloat(out, static_cast<float>(x) * 0.25f);
			putFloat(out, static_cast<float>(y) * 0.25f);
			putFloat(out, static_cast<float>(height(x, y, seed)) / 256.0f);
		}

		struct DCtxDeleter
		{
			void operator()(ZSTD_DCtx* ctx) const noexcept
			{
				ZSTD_freeDCtx(ctx);
			}
		};

		struct BrotliDecoderDeleter
		{
			void operator()(BrotliDecoderState* state) const noexcept
			{
				BrotliDecoderDestroyInstance(state);
			}
		};
	}

	Bytes stlLike(std::size_t size, std::uint64_t seed)
	{
		Bytes out;
		out.reserve(size + kStlTriangleBytes);
		const std::string_view header = "projecto synthetic STL fixture";
		std::ranges::transform(header, std::back_inserter(out), [](char ch)
		{
			return static_cast<std::byte>(ch);
		});
		out.resize(80, std::byte{0});
		const std::size_t triangles = size > kStlHeaderBytes ? (size - kStlHeaderBytes) / kStlTriangleBytes : 0;
		putU32(out, static_cast<std::uint32_t>(triangles));
		for (std::uint32_t index = 0; out.size() < size; ++index)
		{
			const std::uint32_t cell = index / 2U;
			const std::uint32_t x = cell % kStlColumns;
			const std::uint32_t y = cell / kStlColumns;
			const bool upper = (index % 2U) == 1U;
			const std::int32_t here = height(x, y, seed);
			putFloat(out, static_cast<float>(here - height(x + 1U, y, seed)) / 256.0f);
			putFloat(out, static_cast<float>(here - height(x, y + 1U, seed)) / 256.0f);
			putFloat(out, 1.0f);
			if (upper)
			{
				putVertex(out, x + 1U, y, seed);
				putVertex(out, x + 1U, y + 1U, seed);
				putVertex(out, x, y + 1U, seed);
			}
			else
			{
				putVertex(out, x, y, seed);
				putVertex(out, x + 1U, y, seed);
				putVertex(out, x, y + 1U, seed);
			}
			out.push_back(std::byte{0});
			out.push_back(std::byte{0});
		}
		out.resize(size);
		return out;
	}

	Bytes randomBytes(std::size_t size, std::uint64_t seed)
	{
		std::mt19937_64 engine{seed};
		Bytes out(size);
		std::ranges::generate(out, [&engine]()
		{
			return static_cast<std::byte>(engine() >> 56U);
		});
		return out;
	}

	Bytes textLike(std::size_t size)
	{
		std::string text;
		text.reserve(size + 128);
		for (std::uint32_t index = 0; text.size() < size; ++index)
		{
			text += "  facet normal " + std::to_string(index % 17U) + " " + std::to_string(index % 7U) + " 0\n";
			text += "    vertex " + std::to_string(index) + " " + std::to_string(index * 2U) + " " + std::to_string(index % 13U) + "\n";
			text += "  endfacet\n";
		}
		text.resize(size);
		Bytes out(size);
		std::ranges::transform(text, out.begin(), [](char ch)
		{
			return static_cast<std::byte>(ch);
		});
		return out;
	}

	void writeBytes(const fs::path& path, std::span<const std::byte> data)
	{
		std::ofstream out(path, std::ios::binary | std::ios::trunc);
		out.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
		if (!out)
		{
			throw std::runtime_error("cannot write test file " + path.string());
		}
	}

	Bytes readBytes(const fs::path& path)
	{
		std::ifstream in(path, std::ios::binary);
		const std::vector<char> chars{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
		Bytes out(chars.size());
		std::ranges::transform(chars, out.begin(), [](char ch)
		{
			return static_cast<std::byte>(ch);
		});
		return out;
	}

	std::optional<Bytes> decodeZstd(std::span<const std::byte> frame, int windowLogMax)
	{
		const std::unique_ptr<ZSTD_DCtx, DCtxDeleter> ctx{ZSTD_createDCtx()};
		if (!ctx)
		{
			return std::nullopt;
		}
		if (windowLogMax != 0 && ZSTD_isError(ZSTD_DCtx_setParameter(ctx.get(), ZSTD_d_windowLogMax, windowLogMax)) != 0U)
		{
			return std::nullopt;
		}
		Bytes out;
		Bytes chunk(std::size_t{1} << 20);
		ZSTD_inBuffer in{frame.data(), frame.size(), 0};
		while (true)
		{
			ZSTD_outBuffer buffer{chunk.data(), chunk.size(), 0};
			const std::size_t hint = ZSTD_decompressStream(ctx.get(), &buffer, &in);
			if (ZSTD_isError(hint) != 0U)
			{
				return std::nullopt;
			}
			out.insert(out.end(), chunk.begin(), chunk.begin() + static_cast<std::ptrdiff_t>(buffer.pos));
			if (hint == 0 && in.pos == in.size)
			{
				return out;
			}
			if (in.pos == in.size && buffer.pos < buffer.size)
			{
				return std::nullopt;
			}
		}
	}

	std::optional<Bytes> decodeBrotli(std::span<const std::byte> stream, bool largeWindow)
	{
		const std::unique_ptr<BrotliDecoderState, BrotliDecoderDeleter> state{
			BrotliDecoderCreateInstance(nullptr, nullptr, nullptr)};
		if (!state)
		{
			return std::nullopt;
		}
		if (largeWindow && BrotliDecoderSetParameter(state.get(), BROTLI_DECODER_PARAM_LARGE_WINDOW, 1U) == BROTLI_FALSE)
		{
			return std::nullopt;
		}
		Bytes out;
		Bytes chunk(std::size_t{1} << 20);
		std::size_t availableIn = stream.size();
		const auto* nextIn = reinterpret_cast<const std::uint8_t*>(stream.data());
		while (true)
		{
			std::size_t availableOut = chunk.size();
			auto* nextOut = reinterpret_cast<std::uint8_t*>(chunk.data());
			const BrotliDecoderResult result =
				BrotliDecoderDecompressStream(state.get(), &availableIn, &nextIn, &availableOut, &nextOut, nullptr);
			const std::size_t produced = chunk.size() - availableOut;
			out.insert(out.end(), chunk.begin(), chunk.begin() + static_cast<std::ptrdiff_t>(produced));
			if (result == BROTLI_DECODER_RESULT_SUCCESS)
			{
				return availableIn == 0 ? std::optional<Bytes>{std::move(out)} : std::nullopt;
			}
			if (result != BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT)
			{
				return std::nullopt;
			}
		}
	}

	AppRun runCompressor(const std::vector<std::string>& args)
	{
		const std::vector<std::string_view> views(args.begin(), args.end());
		std::ostringstream out;
		std::ostringstream err;
		const ExitCode code = runApp(views, out, err);
		return AppRun{code, out.str(), err.str()};
	}

	std::vector<std::string> compressArgs(std::string_view codec, const fs::path& root,
		std::string_view inputName, std::string_view outputName, std::uint64_t inputSize)
	{
		return {
			"compress",
			"--codec", std::string{codec},
			"--root", root.string(),
			"--input", (root / inputName).string(),
			"--output", (root / outputName).string(),
			"--input-size", std::to_string(inputSize),
		};
	}

	std::vector<std::string> splitLines(std::string_view text)
	{
		std::vector<std::string> lines;
		while (!text.empty())
		{
			const std::size_t end = text.find('\n');
			lines.emplace_back(text.substr(0, end));
			text.remove_prefix(end == std::string_view::npos ? text.size() : end + 1);
		}
		return lines;
	}

	std::optional<std::string> lineOfType(std::string_view out, std::string_view type)
	{
		const std::string prefix = "{\"type\":\"" + std::string{type} + "\"";
		const std::vector<std::string> lines = splitLines(out);
		const auto found = std::ranges::find_if(lines.rbegin(), lines.rend(), [&prefix](const std::string& line)
		{
			return line.starts_with(prefix);
		});
		if (found == lines.rend())
		{
			return std::nullopt;
		}
		return *found;
	}

	std::optional<std::uint64_t> numberField(std::string_view line, std::string_view key)
	{
		const std::string marker = "\"" + std::string{key} + "\":";
		const std::size_t at = line.find(marker);
		if (at == std::string_view::npos)
		{
			return std::nullopt;
		}
		const std::string_view rest = line.substr(at + marker.size());
		std::uint64_t value = 0;
		const auto [ptr, ec] = std::from_chars(rest.data(), rest.data() + rest.size(), value);
		if (ec != std::errc{} || ptr == rest.data())
		{
			return std::nullopt;
		}
		return value;
	}

	std::optional<std::string> textField(std::string_view line, std::string_view key)
	{
		const std::string marker = "\"" + std::string{key} + "\":\"";
		const std::size_t at = line.find(marker);
		if (at == std::string_view::npos)
		{
			return std::nullopt;
		}
		const std::string_view rest = line.substr(at + marker.size());
		return std::string{rest.substr(0, rest.find('"'))};
	}

	bool largeTestsEnabled()
	{
		const char* value = std::getenv("PROJECTO_LARGE_TESTS");
		if (value != nullptr && std::string_view{value} == "1")
		{
			return true;
		}
		std::cout << "PROJECTO_LARGE_TESTS is not set: skipping this test\n";
		return false;
	}
}
