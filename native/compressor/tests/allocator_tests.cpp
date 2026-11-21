#include <doctest/doctest.h>

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <thread>
#include <vector>

#include "projecto/budget_allocator.hpp"

using projecto::BudgetAllocator;

namespace
{
	constexpr std::size_t kHeader = BudgetAllocator::kHeaderBytes;

	bool aligned(const void* block)
	{
		return reinterpret_cast<std::uintptr_t>(block) % alignof(std::max_align_t) == 0;
	}
}

TEST_CASE("blocks are aligned to max_align_t and fully writable")
{
	BudgetAllocator allocator{std::uint64_t{1} << 20};
	for (const std::size_t size : {1U, 3U, 8U, 15U, 16U, 17U, 1000U, 4096U})
	{
		CAPTURE(size);
		void* block = allocator.allocate(size);
		REQUIRE(block != nullptr);
		CHECK(aligned(block));
		std::memset(block, 0xAB, size);
		allocator.deallocate(block);
	}
	CHECK(allocator.current() == 0);
}

TEST_CASE("current and peak count the requested bytes plus one header per block")
{
	BudgetAllocator allocator{std::uint64_t{1} << 20};
	CHECK(allocator.current() == 0);
	CHECK(allocator.peak() == 0);

	void* first = allocator.allocate(100);
	void* second = allocator.allocate(200);
	REQUIRE(first != nullptr);
	REQUIRE(second != nullptr);
	CHECK(allocator.current() == 300 + 2 * kHeader);
	CHECK(allocator.peak() == 300 + 2 * kHeader);

	allocator.deallocate(first);
	CHECK(allocator.current() == 200 + kHeader);
	CHECK(allocator.peak() == 300 + 2 * kHeader);

	void* third = allocator.allocate(50);
	REQUIRE(third != nullptr);
	CHECK(allocator.current() == 250 + 2 * kHeader);
	CHECK(allocator.peak() == 300 + 2 * kHeader);

	allocator.deallocate(second);
	allocator.deallocate(third);
	CHECK(allocator.current() == 0);
	CHECK_FALSE(allocator.refused());
}

TEST_CASE("an allocation over the budget is refused and leaves the counters alone")
{
	BudgetAllocator allocator{1000};
	void* kept = allocator.allocate(500);
	REQUIRE(kept != nullptr);
	const std::uint64_t before = allocator.current();

	CHECK(allocator.allocate(1000) == nullptr);
	CHECK(allocator.refused());
	CHECK(allocator.current() == before);
	CHECK(allocator.peak() == before);

	allocator.deallocate(kept);
	CHECK(allocator.current() == 0);
}

TEST_CASE("an allocation that exactly fills the budget is allowed, one byte more is not")
{
	BudgetAllocator allocator{1000};
	void* full = allocator.allocate(1000 - kHeader);
	REQUIRE(full != nullptr);
	CHECK(allocator.current() == 1000);
	CHECK(allocator.allocate(0) == nullptr);
	allocator.deallocate(full);

	BudgetAllocator other{1000};
	CHECK(other.allocate(1001 - kHeader) == nullptr);
	CHECK(other.refused());
}

TEST_CASE("a size that would overflow with the header is refused, not wrapped")
{
	BudgetAllocator allocator{std::numeric_limits<std::uint64_t>::max()};
	CHECK(allocator.allocate(std::numeric_limits<std::size_t>::max()) == nullptr);
	CHECK(allocator.allocate(std::numeric_limits<std::size_t>::max() - kHeader + 1) == nullptr);
	CHECK(allocator.refused());
	CHECK(allocator.current() == 0);
}

TEST_CASE("a zero-size allocation returns a distinct block that can be freed")
{
	BudgetAllocator allocator{1024};
	void* first = allocator.allocate(0);
	void* second = allocator.allocate(0);
	REQUIRE(first != nullptr);
	REQUIRE(second != nullptr);
	CHECK(first != second);
	CHECK(aligned(first));
	CHECK(allocator.current() == 2 * kHeader);
	allocator.deallocate(first);
	allocator.deallocate(second);
	CHECK(allocator.current() == 0);
}

TEST_CASE("freeing nullptr does nothing")
{
	BudgetAllocator allocator{1024};
	allocator.deallocate(nullptr);
	BudgetAllocator::deallocateThunk(&allocator, nullptr);
	CHECK(allocator.current() == 0);
	CHECK_FALSE(allocator.refused());
}

TEST_CASE("the C thunks route to the allocator passed as opaque")
{
	BudgetAllocator allocator{4096};
	void* opaque = &allocator;
	void* block = BudgetAllocator::allocateThunk(opaque, 64);
	REQUIRE(block != nullptr);
	CHECK(allocator.current() == 64 + kHeader);
	BudgetAllocator::deallocateThunk(opaque, block);
	CHECK(allocator.current() == 0);
	CHECK(BudgetAllocator::allocateThunk(opaque, 8192) == nullptr);
	CHECK(allocator.refused());
}

TEST_CASE("the header keeps blocks aligned and can hold a size")
{
	CHECK(kHeader % alignof(std::max_align_t) == 0);
	CHECK(kHeader >= sizeof(std::size_t));
}

TEST_CASE("peakBlocks counts the most blocks live at once")
{
	BudgetAllocator allocator{std::uint64_t{1} << 20};
	void* first = allocator.allocate(10);
	void* second = allocator.allocate(10);
	allocator.deallocate(first);
	void* third = allocator.allocate(10);
	CHECK(allocator.peakBlocks() == 2);
	allocator.deallocate(second);
	allocator.deallocate(third);
	CHECK(allocator.peakBlocks() == 2);
}

TEST_CASE("setBudget caps later allocations without touching live blocks")
{
	BudgetAllocator allocator{std::uint64_t{1} << 20};
	void* live = allocator.allocate(100);
	REQUIRE(live != nullptr);
	allocator.setBudget(allocator.current());
	CHECK(allocator.budget() == 100 + kHeader);
	CHECK(allocator.allocate(0) == nullptr);
	CHECK(allocator.refused());
	allocator.deallocate(live);
	CHECK(allocator.current() == 0);
}

TEST_CASE("a malloc failure within the budget is a system failure, not a budget refusal")
{
	// No machine can hand out half the address space, so malloc fails while the budget allows it.
	BudgetAllocator allocator{std::numeric_limits<std::uint64_t>::max()};
	CHECK(allocator.allocate(std::numeric_limits<std::size_t>::max() / 2) == nullptr);
	CHECK(allocator.lastFailure() == projecto::AllocationFailure::system);
	CHECK_FALSE(allocator.refused());
	CHECK(allocator.current() == 0);
}

TEST_CASE("takeFailure reports the most recent failure once, then nothing")
{
	BudgetAllocator allocator{1000};
	CHECK(allocator.lastFailure() == projecto::AllocationFailure::none);
	CHECK(allocator.allocate(2000) == nullptr);
	CHECK(allocator.takeFailure() == projecto::AllocationFailure::budget);
	CHECK(allocator.takeFailure() == projecto::AllocationFailure::none);
	CHECK_FALSE(allocator.refused());

	// A later success does not clear an untaken failure: the library may still report it.
	CHECK(allocator.allocate(5000) == nullptr);
	void* block = allocator.allocate(10);
	REQUIRE(block != nullptr);
	CHECK(allocator.refused());
	allocator.deallocate(block);
}

TEST_CASE("fitsBudget leaves room for the block headers on top of the estimate")
{
	constexpr std::uint64_t allowance = BudgetAllocator::kHeaderAllowanceBytes;
	static_assert(allowance == BudgetAllocator::kAllowedLiveBlocks * BudgetAllocator::kHeaderBytes);
	CHECK(projecto::fitsBudget(1000, 1000 + allowance));
	CHECK_FALSE(projecto::fitsBudget(1000, 1000 + allowance - 1));
	CHECK_FALSE(projecto::fitsBudget(1000, 1000));
	CHECK_FALSE(projecto::fitsBudget(2000, 1000));
	CHECK(projecto::fitsBudget(0, std::numeric_limits<std::uint64_t>::max()));
	CHECK_FALSE(projecto::fitsBudget(std::numeric_limits<std::uint64_t>::max(), std::numeric_limits<std::uint64_t>::max()));
}

TEST_CASE("concurrent allocations from many threads never pass the budget and balance to zero")
{
	// zstd workers allocate and free from their own threads. Each thread holds up to 4 blocks of
	// 1 KiB at a time, so the threads together want more than the budget allows and some
	// allocations must be refused; none may push the live total over it.
	constexpr int kThreads = 8;
	constexpr int kRounds = 20'000;
	constexpr std::size_t kBlock = 1024;
	constexpr std::uint64_t budget = 20 * (kBlock + kHeader);
	BudgetAllocator allocator{budget};
	std::atomic<std::uint64_t> refusals = 0;
	std::atomic<std::uint64_t> overBudget = 0;
	{
		std::vector<std::jthread> threads;
		for (int index = 0; index < kThreads; ++index)
		{
			threads.emplace_back([&allocator, &refusals, &overBudget, index]()
			{
				std::array<void*, 4> held{};
				for (int round = 0; round < kRounds; ++round)
				{
					void*& slot = held[static_cast<std::size_t>(round + index) % held.size()];
					if (slot != nullptr)
					{
						allocator.deallocate(slot);
						slot = nullptr;
						continue;
					}
					slot = allocator.allocate(kBlock);
					if (slot == nullptr)
					{
						refusals.fetch_add(1);
						continue;
					}
					std::memset(slot, index, kBlock);
					if (allocator.current() > budget)
					{
						overBudget.fetch_add(1);
					}
				}
				for (void* block : held)
				{
					allocator.deallocate(block);
				}
			});
		}
	}
	CHECK(overBudget.load() == 0);
	CHECK(refusals.load() > 0);
	CHECK(allocator.current() == 0);
	CHECK(allocator.peak() <= budget);
	CHECK(allocator.peak() >= 2 * (kBlock + kHeader));
	CHECK(allocator.peakBlocks() <= 20);
	CHECK(allocator.takeFailure() == projecto::AllocationFailure::budget);
}
