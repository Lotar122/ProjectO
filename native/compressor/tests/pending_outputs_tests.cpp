#include <doctest/doctest.h>

#include <chrono>
#include <filesystem>
#include <future>
#include <mutex>
#include <optional>

#include "projecto/pending_outputs.hpp"
#include "temp_dir.hpp"

using namespace projecto;
using projecto::testing::TempDir;
namespace fs = std::filesystem;

namespace
{
	// True when lock() on another thread is still waiting after a short while.
	bool lockIsHeldElsewhere(PendingOutputs& registry, std::future<void>& waiter)
	{
		waiter = std::async(std::launch::async, [&registry]()
		{
			const auto held = registry.lock();
		});
		return waiter.wait_for(std::chrono::milliseconds{100}) == std::future_status::timeout;
	}
}

TEST_CASE("PendingOutputs: add and erase track the paths, a freeze removes what is still pending")
{
	const TempDir dir;
	const fs::path committed = dir.makeFile("committed.bin", 10);
	const fs::path partial = dir.makeFile("partial.bin", 10);
	PendingOutputs registry;
	{
		const auto held = registry.lock();
		registry.add(held, committed);
		registry.add(held, partial);
		CHECK(registry.size(held) == 2);
		registry.erase(held, committed);
		registry.erase(held, dir.path() / "never-added.bin");
		CHECK(registry.size(held) == 1);
	}

	std::future<void> waiter;
	{
		auto frozen = registry.removeAllAndFreeze();
		CHECK(frozen.owns_lock());
		CHECK(fs::exists(committed));
		CHECK_FALSE(fs::exists(partial));
		CHECK(registry.size(frozen) == 0);
		// Frozen: nothing else gets the lock while the shutdown holds it.
		CHECK(lockIsHeldElsewhere(registry, waiter));
	}
	// Released here only because a test has to; a real shutdown ends the process instead.
	waiter.get();
}

TEST_CASE("PendingOutputs: a closed stdin before the run finished removes the pending output")
{
	const TempDir dir;
	const fs::path partial = dir.makeFile("partial.bin", 10);
	PendingOutputs registry;
	{
		const auto held = registry.lock();
		registry.add(held, partial);
	}

	std::optional<std::unique_lock<std::mutex>> frozen = registry.removeAllAndFreezeUnlessFinished();
	REQUIRE(frozen.has_value());
	CHECK(frozen->owns_lock());
	CHECK_FALSE(fs::exists(partial));
}

TEST_CASE("PendingOutputs: a closed stdin after the run finished changes nothing")
{
	const TempDir dir;
	const fs::path output = dir.makeFile("output.bin", 10);
	PendingOutputs registry;
	{
		const auto held = registry.lock();
		registry.add(held, output);
	}
	registry.markFinished();

	CHECK_FALSE(registry.removeAllAndFreezeUnlessFinished().has_value());
	CHECK(fs::exists(output));
	// Not frozen: the main thread can still take the lock and finish its work.
	const auto held = registry.lock();
	CHECK(registry.size(held) == 1);
}

TEST_CASE("PendingOutputs: eraseCommitted unregisters and marks finished in one hold")
{
	const TempDir dir;
	const fs::path output = dir.makeFile("output.bin", 10);
	PendingOutputs registry;
	{
		const auto held = registry.lock();
		registry.add(held, output);
		registry.eraseCommitted(held, output);
		CHECK(registry.size(held) == 0);
	}
	CHECK_FALSE(registry.removeAllAndFreezeUnlessFinished().has_value());
	CHECK(fs::exists(output));

	// The test-only reset makes a closed stdin stop the process again.
	registry.resetFinishedForTesting();
	CHECK(registry.removeAllAndFreezeUnlessFinished().has_value());
}
