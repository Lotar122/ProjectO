#pragma once

#include <cstdio>
#include <filesystem>
#include <optional>
#include <string>
#include <variant>

#include "projecto/file_io.hpp"

// The one place that detects the platform. Everything else tests these two macros.
#if defined(_WIN32)
	#define PROJECTO_PLATFORM_WINDOWS 1
#elif __has_include(<unistd.h>) && __has_include(<fcntl.h>) && __has_include(<poll.h>) \
	&& __has_include(<sys/stat.h>) && __has_include(<pthread.h>)
	#define PROJECTO_PLATFORM_POSIX 1
#else
	#error "projecto-compress supports POSIX systems (Linux, macOS) and Windows"
#endif

// The only OS-specific code of projecto-compress sits behind these declarations, in
// platform.cpp: a POSIX branch (Linux, macOS) and a Windows branch.
namespace projecto::platform
{
	// An errno value (std::generic_category), 0 for none.
	using ErrorNumber = int;

	// Opens an existing file read-only. POSIX: O_NOFOLLOW (a symlink in the last component
	// fails with ELOOP), O_NONBLOCK (a FIFO cannot block the open), O_NOCTTY (a terminal
	// device never becomes the controlling terminal), close-on-exec.
	std::variant<std::FILE*, ErrorNumber> openForReading(const std::filesystem::path& path);

	// Creates a file that must not exist yet. POSIX: O_EXCL | O_NOFOLLOW, mode 0600 before
	// the umask, close-on-exec. A file that was created but could not be wrapped in a
	// std::FILE is removed again before the error is returned.
	std::variant<std::FILE*, ErrorNumber> createNew(const std::filesystem::path& path);

	// fstat on the handle; leaves the read position alone.
	std::variant<FileFacts, ErrorNumber> inspect(std::FILE* file);

	// fflush, then fsync (POSIX) or _commit (Windows). Returns 0 on success.
	ErrorNumber syncToStorage(std::FILE* file);

	// Stops the process cleanly on SIGTERM, SIGINT and SIGHUP: the signals are blocked here
	// and waited for on a thread of their own, which removes every pending output and then
	// dies of that same signal. A signal that the parent set to be ignored stays ignored.
	// Call it in main() before any other thread exists. Returns a message when the watch
	// could not start (the signals then keep their default action). If waiting for the
	// signals ever fails for a reason other than EINTR, the watch removes every pending
	// output and ends the process with exit 70, rather than leave the signals blocked for
	// good. Nothing to do on Windows, where another process cannot deliver these signals.
	std::optional<std::string> startSignalWatch();

	// Ends the process with exit 3 once stdin reaches end of file or fails, after removing
	// every pending output, so a parent that dies without stopping this process does not
	// leave it running. Anything read from stdin is discarded. A stdin left non-blocking by
	// the parent is waited on with poll(), never taken as closed. Once the run is marked
	// finished (PendingOutputs::markFinished) a closed stdin is ignored, so it cannot turn a
	// decided outcome into exit 3. Returns a message when the watch could not start.
	std::optional<std::string> startStdinWatch();
}
