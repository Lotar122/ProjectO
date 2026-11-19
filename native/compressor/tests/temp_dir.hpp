#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>

namespace projecto::testing
{
	// A fresh directory under the system temp directory, removed on destruction.
	// path() is canonical, as the binary requires of --root.
	class TempDir
	{
	public:
		TempDir()
		{
			static std::atomic<std::uint64_t> counter{0};
			const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
			const std::filesystem::path base = std::filesystem::temp_directory_path();
			path_ = base / ("projecto-test-" + std::to_string(stamp) + "-" + std::to_string(counter.fetch_add(1)));
			std::filesystem::create_directories(path_);
			path_ = std::filesystem::canonical(path_);
		}

		TempDir(const TempDir&) = delete;
		TempDir& operator=(const TempDir&) = delete;

		~TempDir()
		{
			std::error_code ec;
			std::filesystem::remove_all(path_, ec);
		}

		const std::filesystem::path& path() const noexcept
		{
			return path_;
		}

		// Creates a file of `size` bytes (a repeating pattern) and returns its path.
		std::filesystem::path makeFile(const std::string& name, std::size_t size) const
		{
			const std::filesystem::path file = path_ / name;
			std::ofstream out(file, std::ios::binary);
			const std::string block(1024, 'x');
			for (std::size_t written = 0; written < size; written += block.size())
			{
				const std::size_t chunk = size - written < block.size() ? size - written : block.size();
				out.write(block.data(), static_cast<std::streamsize>(chunk));
			}
			return file;
		}

	private:
		std::filesystem::path path_;
	};
}
