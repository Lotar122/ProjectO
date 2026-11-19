#pragma once

#include <iosfwd>
#include <span>
#include <string_view>

#include "projecto/exit_code.hpp"

namespace projecto
{
	// The whole program minus process plumbing, so tests can drive it in memory.
	// args excludes argv[0]. JSON lines go to out, human-readable text to err.
	ExitCode runApp(std::span<const std::string_view> args, std::ostream& out, std::ostream& err);
}
