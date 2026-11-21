#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace projecto
{
	// Why the most recent allocation failed.
	enum class AllocationFailure
	{
		none,
		// The budget would have been exceeded (exit 4).
		budget,
		// Within budget, but the system allocator returned nullptr: the machine is out of
		// memory, which is not a budget decision.
		system,
	};

	// Counting allocator behind the C APIs of zstd (ZSTD_customMem) and brotli
	// (BrotliEncoderCreateInstance). It is the hard memory cap of phase4.md 8.3:
	// an allocation that would take the live total above the budget returns
	// nullptr, the library reports an allocation error, and the run exits 4.
	//
	// Each block carries a header, aligned to alignof(std::max_align_t), that
	// stores the requested size, because neither C API passes it to free.
	// Headers count against the budget.
	//
	// Thread-safe: multithreaded zstd allocates and frees from its worker threads.
	// The counters are atomics, so allocate() and deallocate() take no lock and a
	// worker never waits on another thread inside the allocator. A block's bytes
	// are reserved before malloc() and given back if malloc() fails; on release the
	// block is freed before its bytes leave the live total. So the live total can
	// never pass the budget and the resident memory never passes the live total,
	// whatever the interleaving.
	class BudgetAllocator
	{
	public:
		static constexpr std::size_t kAlignment = alignof(std::max_align_t);
		static constexpr std::size_t kHeaderBytes = (sizeof(std::size_t) + kAlignment - 1) / kAlignment * kAlignment;
		// Headers of up to this many live blocks are allowed for on top of a library's own
		// estimate, which does not know about them (single-threaded zstd keeps 2 blocks live,
		// multithreaded zstd a few per worker, brotli about 25 at a 64 MiB input; the allowance is generous).
		static constexpr std::uint64_t kAllowedLiveBlocks = 4096;
		static constexpr std::uint64_t kHeaderAllowanceBytes = kAllowedLiveBlocks * kHeaderBytes;

		// Where a block's memory comes from once the budget allows it. It must return memory
		// std::free can release, or nullptr when the system is out of memory.
		using SystemAllocate = void* (*)(std::size_t bytes) noexcept;

		// std::malloc, the system allocator every production run uses.
		static void* systemMalloc(std::size_t bytes) noexcept;

		// systemAllocate is for tests: one that returns nullptr on demand drives the
		// out-of-memory path (a system failure, exit 70) without exhausting the machine.
		explicit BudgetAllocator(std::uint64_t budgetBytes, SystemAllocate systemAllocate = &systemMalloc) noexcept
			: budget_(budgetBytes)
			, systemAllocate_(systemAllocate != nullptr ? systemAllocate : &systemMalloc)
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
			return budget_.load();
		}

		// Changes the cap for later allocations; live blocks are not affected.
		void setBudget(std::uint64_t budgetBytes) noexcept
		{
			budget_.store(budgetBytes);
		}

		// Live bytes, headers included (plus any block another thread is reserving right now).
		std::uint64_t current() const noexcept
		{
			return current_.load();
		}

		// Highest value current() has reached with every reserved block allocated.
		std::uint64_t peak() const noexcept
		{
			return peak_.load();
		}

		// Most blocks live at the same time.
		std::uint64_t peakBlocks() const noexcept
		{
			return peakBlocks_.load();
		}

		// The reason the most recent failed allocation failed, until takeFailure() clears it.
		AllocationFailure lastFailure() const noexcept
		{
			return failure_.load();
		}

		// True while the recorded failure is a budget refusal.
		bool refused() const noexcept
		{
			return failure_.load() == AllocationFailure::budget;
		}

		// Returns the recorded failure and clears it, so a failure reported once is not
		// blamed again for a later, unrelated library error.
		AllocationFailure takeFailure() noexcept
		{
			return failure_.exchange(AllocationFailure::none);
		}

		// C-compatible entry points; opaque is the BudgetAllocator.
		static void* allocateThunk(void* opaque, std::size_t size) noexcept;
		static void deallocateThunk(void* opaque, void* block) noexcept;

	private:
		// Adds total to current_ unless that would pass the budget. On success reached is the
		// new live total.
		bool reserve(std::uint64_t total, std::uint64_t& reached) noexcept;

		std::atomic<std::uint64_t> budget_ = 0;
		SystemAllocate systemAllocate_ = &systemMalloc;
		std::atomic<std::uint64_t> current_ = 0;
		std::atomic<std::uint64_t> peak_ = 0;
		std::atomic<std::uint64_t> blocks_ = 0;
		std::atomic<std::uint64_t> peakBlocks_ = 0;
		std::atomic<AllocationFailure> failure_ = AllocationFailure::none;
	};

	// True when a library estimate plus the header allowance fits the budget. The pre-check
	// uses this, so an estimate that only fits without the headers is refused before any output.
	constexpr bool fitsBudget(std::uint64_t estimatedBytes, std::uint64_t budgetBytes) noexcept
	{
		return estimatedBytes <= budgetBytes && budgetBytes - estimatedBytes >= BudgetAllocator::kHeaderAllowanceBytes;
	}
}
