#pragma once

#include <optional>
#include <string>

#include "projecto/protocol.hpp"

namespace projecto
{
	// Version of this binary (from the CMake project version).
	std::string projectVersion();

	// Versions of the linked libraries, as reported by the libraries themselves.
	std::string zstdVersion();
	std::string brotliVersion();

	// The zstd parameters API used here is only safe against the pinned release, so the
	// version is asserted at compile time (version.cpp) and checked here at run time.
	// Returns a message when the linked libraries differ from the pins.
	std::optional<std::string> checkLibraryVersions();

	// {"type":"version","version":"1.0.0","zstd":"1.5.7","brotli":"1.2.1"}
	JsonLine versionLine();
}
