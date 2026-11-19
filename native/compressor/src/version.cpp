#include "projecto/version.hpp"

#include <cstdint>
#include <string>
#include <string_view>

#include <brotli/encode.h>
#include <zstd.h>

#ifndef PROJECTO_VERSION
#error "PROJECTO_VERSION must be defined by the build (see CMakeLists.txt)"
#endif

namespace projecto
{
	namespace
	{
		// Bump only through a reviewed change that also updates cmake/Dependencies.cmake
		// and the memory estimates in phase4-amendments.md (A6).
		constexpr unsigned kPinnedZstdNumber = 10507;
		constexpr std::string_view kPinnedZstdString = "1.5.7";
		constexpr std::uint32_t kPinnedBrotliNumber = (1U << 24U) | (2U << 12U) | 1U;
		constexpr std::string_view kPinnedBrotliString = "1.2.1";

		static_assert(ZSTD_VERSION_NUMBER == kPinnedZstdNumber, "projecto-compress is pinned to zstd 1.5.7");
		static_assert(std::string_view{ZSTD_VERSION_STRING} == kPinnedZstdString, "projecto-compress is pinned to zstd 1.5.7");
	}

	std::string projectVersion()
	{
		return PROJECTO_VERSION;
	}

	std::string zstdVersion()
	{
		return ZSTD_versionString();
	}

	std::string brotliVersion()
	{
		const std::uint32_t version = BrotliEncoderVersion();
		return std::to_string(version >> 24U) + "." + std::to_string((version >> 12U) & 0xFFFU) + "."
			+ std::to_string(version & 0xFFFU);
	}

	std::optional<std::string> checkLibraryVersions()
	{
		if (ZSTD_versionNumber() != kPinnedZstdNumber)
		{
			return "linked zstd is " + zstdVersion() + ", expected " + std::string{kPinnedZstdString};
		}
		if (BrotliEncoderVersion() != kPinnedBrotliNumber)
		{
			return "linked brotli is " + brotliVersion() + ", expected " + std::string{kPinnedBrotliString};
		}
		return std::nullopt;
	}

	JsonLine versionLine()
	{
		JsonLine line{"version"};
		line.text("version", projectVersion()).text("zstd", zstdVersion()).text("brotli", brotliVersion());
		return line;
	}
}
