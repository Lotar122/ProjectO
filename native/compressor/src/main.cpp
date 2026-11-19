#include <csignal>
#include <exception>
#include <iostream>
#include <string_view>
#include <vector>

#include "projecto/app.hpp"
#include "projecto/exit_code.hpp"
#include "projecto/protocol.hpp"

namespace
{
	int reportUnexpected(const char* what) noexcept
	{
		try
		{
			// Nothing more can be done when stdout is gone; the exit code still tells.
			static_cast<void>(projecto::writeLine(std::cout, projecto::errorResult(projecto::ExitCode::internal, what)));
			std::cerr << "projecto-compress: unexpected error: " << what << '\n';
		}
		catch (...)
		{
		}
		return projecto::toInt(projecto::ExitCode::internal);
	}
}

int main(int argc, char** argv)
{
#ifdef SIGPIPE
	// A closed stdout pipe must surface as a failed write (exit 3, output removed),
	// not as a signal that kills the process and leaves the partial output behind.
	std::signal(SIGPIPE, SIG_IGN);
#endif
	try
	{
		const std::vector<std::string_view> args(argv + (argc > 0 ? 1 : 0), argv + (argc > 0 ? argc : 0));
		return projecto::toInt(projecto::runApp(args, std::cout, std::cerr));
	}
	catch (const std::exception& error)
	{
		return reportUnexpected(error.what());
	}
	catch (...)
	{
		return reportUnexpected("unknown exception");
	}
}
