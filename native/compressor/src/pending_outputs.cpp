#include "projecto/pending_outputs.hpp"

#include <algorithm>
#include <cassert>

#include "projecto/file_io.hpp"

namespace projecto
{
	namespace fs = std::filesystem;

	PendingOutputs& PendingOutputs::instance() noexcept
	{
		// A union member is only destroyed when the union's destructor does so, and this one
		// does not: the registry outlives static destruction, which a shutdown thread may race.
		union Holder
		{
			Holder()
				: object{}
			{
			}

			~Holder()
			{
			}

			PendingOutputs object;
		};
		static Holder holder;
		return holder.object;
	}

	std::unique_lock<std::mutex> PendingOutputs::lock()
	{
		return std::unique_lock<std::mutex>{mutex_};
	}

	void PendingOutputs::add(const std::unique_lock<std::mutex>& held, const fs::path& path)
	{
		assert(holds(held));
		static_cast<void>(held);
		paths_.push_back(path);
	}

	void PendingOutputs::erase(const std::unique_lock<std::mutex>& held, const fs::path& path) noexcept
	{
		assert(holds(held));
		static_cast<void>(held);
		const auto found = std::ranges::find(paths_, path);
		if (found != paths_.end())
		{
			paths_.erase(found);
		}
	}

	std::size_t PendingOutputs::size(const std::unique_lock<std::mutex>& held) const noexcept
	{
		assert(holds(held));
		static_cast<void>(held);
		return paths_.size();
	}

	void PendingOutputs::eraseCommitted(const std::unique_lock<std::mutex>& held, const fs::path& path) noexcept
	{
		erase(held, path);
		finished_ = true;
	}

	void PendingOutputs::markFinished() noexcept
	{
		const auto held = lock();
		finished_ = true;
	}

	void PendingOutputs::resetFinishedForTesting() noexcept
	{
		const auto held = lock();
		finished_ = false;
	}

	std::unique_lock<std::mutex> PendingOutputs::removeAllAndFreeze() noexcept
	{
		auto held = lock();
		removeAll(held);
		return held;
	}

	std::optional<std::unique_lock<std::mutex>> PendingOutputs::removeAllAndFreezeUnlessFinished() noexcept
	{
		auto held = lock();
		if (finished_)
		{
			return std::nullopt;
		}
		removeAll(held);
		return held;
	}

	void PendingOutputs::removeAll(const std::unique_lock<std::mutex>& held) noexcept
	{
		assert(holds(held));
		static_cast<void>(held);
		std::ranges::for_each(paths_, [](const fs::path& path)
		{
			removeQuietly(path);
		});
		paths_.clear();
	}

	bool PendingOutputs::holds(const std::unique_lock<std::mutex>& held) const noexcept
	{
		return held.owns_lock() && held.mutex() == &mutex_;
	}
}
