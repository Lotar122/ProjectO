#pragma once

#include <cstddef>
#include <filesystem>
#include <mutex>
#include <optional>
#include <vector>

namespace projecto
{
	// Process-wide list of outputs that were created but not yet committed, so a shutdown
	// on another thread (a signal, or a closed stdin) can remove them before the process
	// ends. OutputFile creates its file and registers it under one hold of lock(), and
	// removes and unregisters it under another, so a shutdown never sees a created file
	// that is not listed. commit() syncs and closes the file without the lock and only then
	// takes it to unregister the path and mark the run finished, both in one hold: a
	// shutdown in the gap before still removes the complete file, which is safe because no
	// result was reported for it yet, and one after it finds the run already finished.
	class PendingOutputs
	{
	public:
		// The process-wide registry. Never destroyed: a shutdown thread may still need it
		// while the process exits.
		static PendingOutputs& instance() noexcept;

		// A separate registry, for tests. The process uses instance().
		PendingOutputs() = default;
		~PendingOutputs() = default;

		PendingOutputs(const PendingOutputs&) = delete;
		PendingOutputs& operator=(const PendingOutputs&) = delete;

		[[nodiscard]] std::unique_lock<std::mutex> lock();

		// These take the lock returned by lock() as proof that it is held (asserted in
		// debug builds).
		void add(const std::unique_lock<std::mutex>& held, const std::filesystem::path& path);
		void erase(const std::unique_lock<std::mutex>& held, const std::filesystem::path& path) noexcept;
		[[nodiscard]] std::size_t size(const std::unique_lock<std::mutex>& held) const noexcept;

		// erase() and markFinished() in the hold the caller already has, so no shutdown can
		// run between them. For OutputFile::commit().
		void eraseCommitted(const std::unique_lock<std::mutex>& held, const std::filesystem::path& path) noexcept;

		// The run's outcome is decided (its output committed): a closed stdin no longer
		// stops the process. One-way for the process. Terminates if the mutex cannot be
		// locked, like removeAllAndFreeze().
		void markFinished() noexcept;

		// Clears the finished mark. Only for tests that share instance() and must not depend
		// on what an earlier test committed.
		void resetFinishedForTesting() noexcept;

		// Removes every pending output and returns the lock still held. The caller ends the
		// process without releasing it, so nothing can be created or committed afterwards.
		// Only for such a caller (and tests, which release it). Terminates if the mutex
		// cannot be locked, which only a corrupted mutex can cause.
		[[nodiscard]] std::unique_lock<std::mutex> removeAllAndFreeze() noexcept;

		// The same, unless markFinished() ran first: then nothing is removed, the lock is
		// released and the result is empty. The check and the removal happen under one
		// hold of the lock, so markFinished() cannot slip in between.
		[[nodiscard]] std::optional<std::unique_lock<std::mutex>> removeAllAndFreezeUnlessFinished() noexcept;

	private:
		void removeAll(const std::unique_lock<std::mutex>& held) noexcept;
		[[nodiscard]] bool holds(const std::unique_lock<std::mutex>& held) const noexcept;

		std::mutex mutex_;
		std::vector<std::filesystem::path> paths_;
		// Guarded by mutex_. A lone atomic would not do: the stdin watch must decide and
		// remove under the same lock that markFinished() takes.
		bool finished_ = false;
	};
}
