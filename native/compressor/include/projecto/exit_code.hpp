#pragma once

#include <string_view>

namespace projecto
{
	// Process exit codes of projecto-compress (phase4.md section 7.3).
	enum class ExitCode : int
	{
		ok = 0,
		usage = 2,
		io = 3,
		budget = 4,
		codec = 5,
		internal = 70,
	};

	constexpr int toInt(ExitCode code) noexcept
	{
		return static_cast<int>(code);
	}

	// Value of the "error" key in a failing "result" line, e.g. "memory_budget".
	std::string_view errorName(ExitCode code) noexcept;
}
