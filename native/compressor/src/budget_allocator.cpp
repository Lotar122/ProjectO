#include "projecto/budget_allocator.hpp"

#include <cstdlib>
#include <cstring>
#include <limits>

namespace projecto
{
	static_assert(BudgetAllocator::kHeaderBytes >= sizeof(std::size_t));
	static_assert(BudgetAllocator::kHeaderBytes % BudgetAllocator::kAlignment == 0);
	static_assert(std::atomic<std::uint64_t>::is_always_lock_free, "the allocator must not lock: zstd workers call it");

	namespace
	{
		// Raises target to at least value.
		void raiseTo(std::atomic<std::uint64_t>& target, std::uint64_t value) noexcept
		{
			std::uint64_t seen = target.load();
			while (seen < value && !target.compare_exchange_weak(seen, value))
			{
			}
		}
	}

	bool BudgetAllocator::reserve(std::uint64_t total, std::uint64_t& reached) noexcept
	{
		const std::uint64_t budget = budget_.load();
		std::uint64_t live = current_.load();
		do
		{
			if (total > budget || live > budget - total)
			{
				return false;
			}
		}
		while (!current_.compare_exchange_weak(live, live + total));
		reached = live + total;
		return true;
	}

	// systemMalloc and deallocate are the one place that calls std::malloc and std::free: they
	// back a C API, and every block allocate() hands out goes back through deallocate().
	void* BudgetAllocator::systemMalloc(std::size_t bytes) noexcept
	{
		return std::malloc(bytes);
	}

	void* BudgetAllocator::allocate(std::size_t size) noexcept
	{
		// A size that cannot even carry its header is larger than any budget.
		if (size > std::numeric_limits<std::size_t>::max() - kHeaderBytes)
		{
			failure_.store(AllocationFailure::budget);
			return nullptr;
		}
		const std::size_t total = size + kHeaderBytes;
		std::uint64_t reached = 0;
		if (!reserve(total, reached))
		{
			failure_.store(AllocationFailure::budget);
			return nullptr;
		}
		void* raw = systemAllocate_(total);
		if (raw == nullptr)
		{
			current_.fetch_sub(total);
			failure_.store(AllocationFailure::system);
			return nullptr;
		}
		std::memcpy(raw, &size, sizeof(size));
		raiseTo(peak_, reached);
		raiseTo(peakBlocks_, blocks_.fetch_add(1) + 1);
		return static_cast<std::byte*>(raw) + kHeaderBytes;
	}

	void BudgetAllocator::deallocate(void* block) noexcept
	{
		if (block == nullptr)
		{
			return;
		}
		std::byte* raw = static_cast<std::byte*>(block) - kHeaderBytes;
		std::size_t size = 0;
		std::memcpy(&size, raw, sizeof(size));
		// The block is freed before its bytes leave the live total, so the memory the process
		// holds never exceeds what current() reports against the budget.
		std::free(raw);
		blocks_.fetch_sub(1);
		current_.fetch_sub(size + kHeaderBytes);
	}

	void* BudgetAllocator::allocateThunk(void* opaque, std::size_t size) noexcept
	{
		return static_cast<BudgetAllocator*>(opaque)->allocate(size);
	}

	void BudgetAllocator::deallocateThunk(void* opaque, void* block) noexcept
	{
		static_cast<BudgetAllocator*>(opaque)->deallocate(block);
	}
}
