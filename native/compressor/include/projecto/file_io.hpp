#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

namespace projecto
{
	inline constexpr std::size_t kIoBufferBytes = std::size_t{1} << 20;

	using Buffer = std::vector<std::byte>;

	// A 1 MiB zero-filled buffer for chunked reads and writes.
	Buffer makeIoBuffer();

	struct IoError
	{
		std::string message;
	};

	// What the open handle itself refers to, so checks cannot be fooled by a path that
	// was swapped after validation.
	struct FileFacts
	{
		bool regular = false;
		std::uint64_t links = 0;
		std::uint64_t size = 0;
	};

	// Move-only owner of a std::FILE*. The destructor closes quietly; call close()
	// to learn whether the final flush succeeded. The OS-specific opens live in platform.cpp.
	class File
	{
	public:
		// Read-only. On POSIX the open does not follow a symlink in the last component and
		// cannot block on a FIFO; check the type with inspect() before reading.
		static std::variant<File, IoError> openRead(const std::filesystem::path& path);
		// Fails if the path already exists (a dangling symlink counts as existing).
		// On POSIX the file is created with mode 0600 (before the umask).
		static std::variant<File, IoError> createExclusive(const std::filesystem::path& path);

		File(File&&) noexcept = default;
		File& operator=(File&&) noexcept = default;
		File(const File&) = delete;
		File& operator=(const File&) = delete;
		~File() = default;

		bool isOpen() const noexcept
		{
			return file_ != nullptr;
		}

		// Bytes read: 0 is end of file, anything below buffer.size() is a short read.
		// An empty buffer reads nothing and returns 0 without touching the file.
		std::variant<std::size_t, IoError> read(std::span<std::byte> buffer);
		std::optional<IoError> write(std::span<const std::byte> data);
		// Type, link count and size of the open file, measured on the handle (64-bit sizes
		// on every platform). Does not move the read position.
		std::variant<FileFacts, IoError> inspect() const;
		// Size of the open file, measured on the handle.
		std::variant<std::uint64_t, IoError> size() const;
		// Flushes the stdio buffer and asks the OS to put the data on stable storage.
		std::optional<IoError> sync();
		// Flushes and closes. Safe to call twice.
		std::optional<IoError> close();

		// True only for a file this object created with createExclusive(), so cleanup
		// never removes a path that some other process created.
		bool createdByThisProcess() const noexcept
		{
			return created_;
		}

		const std::filesystem::path& path() const noexcept
		{
			return path_;
		}

	private:
		struct Closer
		{
			void operator()(std::FILE* file) const noexcept;
		};

		File(std::FILE* file, std::filesystem::path path, bool created);

		std::unique_ptr<std::FILE, Closer> file_;
		std::filesystem::path path_;
		bool created_ = false;
	};

	// Best-effort removal, for partial output after a failure. Never throws.
	void removeQuietly(const std::filesystem::path& path) noexcept;
}
