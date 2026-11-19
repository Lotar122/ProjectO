#include "projecto/budget_allocator.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace projecto
{
	static_assert(BudgetAllocator::kHeaderBytes >= sizeof(std::size_t));
	static_assert(BudgetAllocator::kHeaderBytes % BudgetAllocator::kAlignment == 0);

	// This is the one place that calls std::malloc and std::free: it backs a C API,
	// and every block it hands out goes back through deallocate().
	void* BudgetAllocator::allocate(std::size_t size) noexcept
	{
		if (size > std::numeric_limits<std::size_t>::max() - kHeaderBytes)
		{
			refused_ = true;
			return nullptr;
		}
		const std::size_t total = size + kHeaderBytes;
		if (total > budget_ || current_ > budget_ - total)
		{
			refused_ = true;
			return nullptr;
		}
		void* raw = std::malloc(total);
		if (raw == nullptr)
		{
			refused_ = true;
			return nullptr;
		}
		std::memcpy(raw, &size, sizeof(size));
		current_ += total;
		peak_ = std::max(peak_, current_);
		++blocks_;
		peakBlocks_ = std::max(peakBlocks_, blocks_);
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
		current_ -= size + kHeaderBytes;
		--blocks_;
		std::free(raw);
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
