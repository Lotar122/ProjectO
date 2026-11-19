#include "projecto/exit_code.hpp"

namespace projecto
{
	std::string_view errorName(ExitCode code) noexcept
	{
		switch (code)
		{
			case ExitCode::ok:
				return "ok";
			case ExitCode::usage:
				return "usage";
			case ExitCode::io:
				return "io";
			case ExitCode::budget:
				return "memory_budget";
			case ExitCode::codec:
				return "codec";
			case ExitCode::internal:
				return "internal";
		}
		return "internal";
	}
}
