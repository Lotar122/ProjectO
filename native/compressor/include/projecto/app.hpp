#pragma once

#include <functional>
#include <iosfwd>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "projecto/codec_common.hpp"
#include "projecto/exit_code.hpp"

namespace projecto
{
	// Starts the stdin watch for `--watch-stdin 1`; returns a message when it cannot.
	// main() passes platform::startStdinWatch, tests pass a fake or nothing.
	using StdinWatchStarter = std::function<std::optional<std::string>()>;

	// The whole program minus process plumbing, so tests can drive it in memory.
	// args excludes argv[0]. JSON lines go to out, human-readable text to err.
	// startStdinWatch is called once the arguments parsed, before any file is touched,
	// and only when they ask for it; without a starter that request is an internal error.
	// workerCleanup is WorkerCleanup::abandon only in main(), which exits right after a failed
	// run, so a failing multithreaded zstd run does not wait for its workers' jobs to finish.
	ExitCode runApp(std::span<const std::string_view> args, std::ostream& out, std::ostream& err,
		const StdinWatchStarter& startStdinWatch = {}, WorkerCleanup workerCleanup = WorkerCleanup::wait);
}
