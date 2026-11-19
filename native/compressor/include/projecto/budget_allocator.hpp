#pragma once

#include <cstddef>
#include <cstdint>

namespace projecto
{
	// Counting allocator behind the C APIs of zstd (ZSTD_customMem) and brotli
	// (BrotliEncoderCreateInstance). It is the hard memory cap of phase4.md 8.3:
	// an allocation that would take the live total above the budget returns
	// nullptr, the library reports an allocation error, and the run exits 4.
	//
	// Each block carries a header, aligned to alignof(std::max_align_t), that
	// stores the requested size, because neither C API passes it to free.
	// Headers count against the budget. Single-threaded: both encoders run
	// without worker threads.
	class BudgetAllocator
	{
	public:
		static constexpr std::size_t kAlignment = alignof(std::max_align_t);
		static constexpr std::size_t kHeaderBytes = (sizeof(std::size_t) + kAlignment - 1) / kAlignment * kAlignment;
		// Headers of up to this many live blocks are allowed for on top of a library's own
		// estimate, which does not know about them (zstd keeps 2 blocks live, brotli a few hundred).
		static constexpr std::uint64_t kAllowedLiveBlocks = 4096;
		static constexpr std::uint64_t kHeaderAllowanceBytes = kAllowedLiveBlocks * kHeaderBytes;

		explicit BudgetAllocator(std::uint64_t budgetBytes) noexcept
			: budget_(budgetBytes)
		{
		}

		// The address is handed to C code as the opaque pointer, so it must not move.
		BudgetAllocator(const BudgetAllocator&) = delete;
		BudgetAllocator& operator=(const BudgetAllocator&) = delete;
		BudgetAllocator(BudgetAllocator&&) = delete;
		BudgetAllocator& operator=(BudgetAllocator&&) = delete;
		~BudgetAllocator() = default;

		// A block of at least `size` bytes aligned to kAlignment, or nullptr when the
		// budget (or the system) refuses. A zero-size request gets a unique block.
		void* allocate(std::size_t size) noexcept;
		// Accepts nullptr.
		void deallocate(void* block) noexcept;

		std::uint64_t budget() const noexcept
		{
			return budget_;
		}

		// Changes the cap for later allocations; live blocks are not affected.
		void setBudget(std::uint64_t budgetBytes) noexcept
		{
			budget_ = budgetBytes;
		}

		// Live bytes, headers included.
		std::uint64_t current() const noexcept
		{
			return current_;
		}

		// Highest value current() has reached.
		std::uint64_t peak() const noexcept
		{
			return peak_;
		}

		// Most blocks live at the same time.
		std::uint64_t peakBlocks() const noexcept
		{
			return peakBlocks_;
		}

		// True once any allocation was refused.
		bool refused() const noexcept
		{
			return refused_;
		}

		// C-compatible entry points; opaque is the BudgetAllocator.
		static void* allocateThunk(void* opaque, std::size_t size) noexcept;
		static void deallocateThunk(void* opaque, void* block) noexcept;

	private:
		std::uint64_t budget_ = 0;
		std::uint64_t current_ = 0;
		std::uint64_t peak_ = 0;
		std::uint64_t blocks_ = 0;
		std::uint64_t peakBlocks_ = 0;
		bool refused_ = false;
	};

	// True when a library estimate plus the header allowance fits the budget. The pre-check
	// uses this, so an estimate that only fits without the headers is refused before any output.
	constexpr bool fitsBudget(std::uint64_t estimatedBytes, std::uint64_t budgetBytes) noexcept
	{
		return estimatedBytes <= budgetBytes && budgetBytes - estimatedBytes >= BudgetAllocator::kHeaderAllowanceBytes;
	}
}
