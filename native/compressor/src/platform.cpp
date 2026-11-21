#include "projecto/platform.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <string_view>
#include <system_error>
#include <thread>

#include "projecto/exit_code.hpp"
#include "projecto/pending_outputs.hpp"

// platform.hpp picked the branch; only the system headers are left to include.
#if defined(PROJECTO_PLATFORM_WINDOWS)
	#include <io.h>
	#include <sys/stat.h>
#elif defined(PROJECTO_PLATFORM_POSIX)
	#include <fcntl.h>
	#include <poll.h>
	#include <pthread.h>
	#include <sys/stat.h>
	#include <unistd.h>
#endif

namespace projecto::platform
{
	namespace fs = std::filesystem;

	namespace
	{
		constexpr std::string_view kStdinClosedMessage = "projecto-compress: stdin was closed, stopping and removing the partial output\n";

		std::string threadFailure(std::string_view what, const std::system_error& error)
		{
			std::string message{what};
			message += ": ";
			message += error.what();
			return message;
		}

		// Straight to the stderr descriptor, without the stream the main thread may be using.
		// Best effort: there is nothing left to do when stderr is gone. On POSIX it also gives
		// up when stderr stays full (a parent that stopped reading), so the shutdown that
		// called it cannot hang. The descriptor's own flags are shared with the parent and
		// not ours to change, so each write waits in poll() for room first, with a deadline.
		void writeStderr(std::string_view text) noexcept
		{
#if defined(PROJECTO_PLATFORM_POSIX)
			// POLLOUT on a pipe promises room for at least PIPE_BUF bytes, and PIPE_BUF is
			// never below 512, so a write of this size does not block once poll() says so.
			constexpr std::size_t kChunkBytes = 512;
			const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds{250};
#endif
			while (!text.empty())
			{
#if defined(PROJECTO_PLATFORM_POSIX)
				const auto left = std::chrono::ceil<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
				if (left.count() <= 0)
				{
					return;
				}
				pollfd target{};
				target.fd = STDERR_FILENO;
				target.events = POLLOUT;
				const int ready = ::poll(&target, 1, static_cast<int>(left.count()));
				if (ready < 0 && errno == EINTR)
				{
					continue;
				}
				// Timed out, failed, or the descriptor reports an error or hang-up instead of room.
				if (ready <= 0 || (target.revents & POLLOUT) == 0)
				{
					return;
				}
				const auto written = ::write(STDERR_FILENO, text.data(), std::min(text.size(), kChunkBytes));
				if (written < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK))
				{
					continue;
				}
#else
				const auto written = ::_write(2, text.data(), static_cast<unsigned int>(text.size()));
#endif
				if (written <= 0)
				{
					return;
				}
				text.remove_prefix(static_cast<std::size_t>(written));
			}
		}

		// Shared end of both stdin watches. Returns, leaving the process alone, only when the
		// run was already marked finished.
		void stopForClosedStdin() noexcept
		{
			const auto frozen = PendingOutputs::instance().removeAllAndFreezeUnlessFinished();
			if (!frozen)
			{
				return;
			}
			writeStderr(kStdinClosedMessage);
			// No stdio flush and no static destructors: the main thread may be mid-write.
			// The registry lock stays held until the process is gone.
			std::_Exit(toInt(ExitCode::io));
		}
	}

#if defined(PROJECTO_PLATFORM_POSIX)

	namespace
	{
		// createdPath names the file the descriptor just created, so a failure removes it
		// again; nullptr for a file that existed before.
		std::variant<std::FILE*, ErrorNumber> wrap(int descriptor, const char* mode, const fs::path* createdPath)
		{
			std::FILE* file = ::fdopen(descriptor, mode);
			if (file == nullptr)
			{
				const int error = errno;
				::close(descriptor);
				if (createdPath != nullptr)
				{
					::unlink(createdPath->c_str());
				}
				return error;
			}
			return file;
		}

		// Signals that end the run. Their default action is to terminate, so taking them over
		// changes nothing except that the partial output is removed first.
		constexpr std::array kStopSignals{SIGTERM, SIGINT, SIGHUP};

		[[noreturn]] void stopForSignal(int signalNumber) noexcept
		{
			// Held until the process is gone.
			const auto frozen = PendingOutputs::instance().removeAllAndFreeze();
			writeStderr("projecto-compress: stopped by a signal, partial output removed\n");
			// Die of the same signal, so the parent sees the usual signal exit.
			struct sigaction action{};
			action.sa_handler = SIG_DFL;
			sigemptyset(&action.sa_mask);
			::sigaction(signalNumber, &action, nullptr);
			sigset_t only;
			sigemptyset(&only);
			sigaddset(&only, signalNumber);
			::pthread_sigmask(SIG_UNBLOCK, &only, nullptr);
			std::raise(signalNumber);
			std::_Exit(128 + signalNumber);
		}

		// sigwait only fails for an invalid set, which would fail every time. Leaving the
		// signals blocked would make the process deaf to SIGTERM, so it ends here instead.
		[[noreturn]] void stopForBrokenSignalWatch(int error) noexcept
		{
			// Held until the process is gone.
			const auto frozen = PendingOutputs::instance().removeAllAndFreeze();
			writeStderr("projecto-compress: waiting for stop signals failed (");
			writeStderr(std::strerror(error));
			writeStderr("), stopping and removing the partial output\n");
			std::_Exit(toInt(ExitCode::internal));
		}

		// Read end of file or a hard error on stdin: the parent is gone. A stdin the parent
		// left non-blocking (the open file description is shared, so its flags are not ours
		// to change) is waited on with poll() instead.
		void waitForStdinToClose() noexcept
		{
			std::array<char, 512> discard{};
			for (;;)
			{
				const ssize_t count = ::read(STDIN_FILENO, discard.data(), discard.size());
				if (count == 0)
				{
					return;
				}
				if (count > 0 || errno == EINTR)
				{
					continue;
				}
				if (errno != EAGAIN && errno != EWOULDBLOCK)
				{
					return;
				}
				pollfd watched{};
				watched.fd = STDIN_FILENO;
				watched.events = POLLIN;
				// Readable, hung up or failed: the next read() tells which. A failing poll()
				// (EINTR, or ENOMEM) proves nothing about the parent, so wait a moment and retry.
				if (::poll(&watched, 1, -1) < 0 && errno != EINTR)
				{
					std::this_thread::sleep_for(std::chrono::milliseconds{100});
				}
			}
		}
	}

	std::variant<std::FILE*, ErrorNumber> openForReading(const fs::path& path)
	{
		const int descriptor = ::open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
		if (descriptor < 0)
		{
			return errno;
		}
		// O_NONBLOCK was only for the open itself; reads from a regular file never block anyway.
		const int flags = ::fcntl(descriptor, F_GETFL);
		if (flags < 0 || ::fcntl(descriptor, F_SETFL, flags & ~O_NONBLOCK) < 0)
		{
			const int error = errno;
			::close(descriptor);
			return error;
		}
		return wrap(descriptor, "rb", nullptr);
	}

	std::variant<std::FILE*, ErrorNumber> createNew(const fs::path& path)
	{
		const int descriptor = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR);
		if (descriptor < 0)
		{
			return errno;
		}
		return wrap(descriptor, "wb", &path);
	}

	std::variant<FileFacts, ErrorNumber> inspect(std::FILE* file)
	{
		struct stat status{};
		if (::fstat(::fileno(file), &status) != 0)
		{
			return errno;
		}
		FileFacts facts;
		facts.regular = S_ISREG(status.st_mode);
		facts.links = static_cast<std::uint64_t>(status.st_nlink);
		facts.size = status.st_size < 0 ? 0 : static_cast<std::uint64_t>(status.st_size);
		return facts;
	}

	ErrorNumber syncToStorage(std::FILE* file)
	{
		errno = 0;
		if (std::fflush(file) != 0)
		{
			return errno;
		}
		while (::fsync(::fileno(file)) != 0)
		{
			if (errno != EINTR)
			{
				return errno;
			}
		}
		return 0;
	}

	std::optional<std::string> startSignalWatch()
	{
		sigset_t watched;
		sigemptyset(&watched);
		bool any = false;
		for (const int signalNumber : kStopSignals)
		{
			// A signal the parent set to be ignored (nohup, a background job) stays ignored.
			struct sigaction current{};
			if (::sigaction(signalNumber, nullptr, &current) == 0 && current.sa_handler == SIG_IGN)
			{
				continue;
			}
			sigaddset(&watched, signalNumber);
			any = true;
		}
		if (!any)
		{
			return std::nullopt;
		}
		if (const int error = ::pthread_sigmask(SIG_BLOCK, &watched, nullptr); error != 0)
		{
			return "cannot block the stop signals: " + std::generic_category().message(error);
		}
		try
		{
			std::thread{[watched]()
			{
				int signalNumber = 0;
				for (;;)
				{
					const int error = ::sigwait(&watched, &signalNumber);
					if (error == 0)
					{
						stopForSignal(signalNumber);
					}
					// POSIX lists no EINTR for sigwait, but some systems (macOS among them)
					// return it when the wait is interrupted; only that is worth a retry.
					if (error != EINTR)
					{
						stopForBrokenSignalWatch(error);
					}
				}
			}}.detach();
		}
		catch (const std::system_error& error)
		{
			::pthread_sigmask(SIG_UNBLOCK, &watched, nullptr);
			return threadFailure("cannot start the signal watch", error);
		}
		return std::nullopt;
	}

	std::optional<std::string> startStdinWatch()
	{
		try
		{
			std::thread{[]()
			{
				waitForStdinToClose();
				stopForClosedStdin();
			}}.detach();
		}
		catch (const std::system_error& error)
		{
			return threadFailure("cannot start the stdin watch", error);
		}
		return std::nullopt;
	}

#elif defined(PROJECTO_PLATFORM_WINDOWS)

	namespace
	{
		std::variant<std::FILE*, ErrorNumber> openWithMode(const fs::path& path, const char* mode)
		{
			errno = 0;
			std::FILE* file = std::fopen(path.string().c_str(), mode);
			if (file == nullptr)
			{
				return errno;
			}
			return file;
		}
	}

	std::variant<std::FILE*, ErrorNumber> openForReading(const fs::path& path)
	{
		return openWithMode(path, "rb");
	}

	std::variant<std::FILE*, ErrorNumber> createNew(const fs::path& path)
	{
		// The file gets the directory's inherited ACL; there is no mode to set.
		return openWithMode(path, "wbx");
	}

	std::variant<FileFacts, ErrorNumber> inspect(std::FILE* file)
	{
		struct _stat64 status{};
		if (::_fstat64(::_fileno(file), &status) != 0)
		{
			return errno;
		}
		FileFacts facts;
		facts.regular = (status.st_mode & _S_IFMT) == _S_IFREG;
		facts.links = static_cast<std::uint64_t>(status.st_nlink);
		facts.size = status.st_size < 0 ? 0 : static_cast<std::uint64_t>(status.st_size);
		return facts;
	}

	ErrorNumber syncToStorage(std::FILE* file)
	{
		errno = 0;
		if (std::fflush(file) != 0 || ::_commit(::_fileno(file)) != 0)
		{
			return errno;
		}
		return 0;
	}

	std::optional<std::string> startSignalWatch()
	{
		return std::nullopt;
	}

	std::optional<std::string> startStdinWatch()
	{
		try
		{
			std::thread{[]()
			{
				std::array<char, 512> discard{};
				while (::_read(0, discard.data(), static_cast<unsigned int>(discard.size())) > 0)
				{
				}
				stopForClosedStdin();
			}}.detach();
		}
		catch (const std::system_error& error)
		{
			return threadFailure("cannot start the stdin watch", error);
		}
		return std::nullopt;
	}

#endif
}
