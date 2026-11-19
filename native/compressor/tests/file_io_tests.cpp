#include <doctest/doctest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <span>
#include <string>
#include <variant>

#include "projecto/file_io.hpp"
#include "temp_dir.hpp"

using namespace projecto;
using projecto::testing::TempDir;
namespace fs = std::filesystem;

namespace
{
	File mustCreate(const fs::path& path)
	{
		auto result = File::createExclusive(path);
		REQUIRE(std::holds_alternative<File>(result));
		return std::move(std::get<File>(result));
	}

	File mustOpen(const fs::path& path)
	{
		auto result = File::openRead(path);
		REQUIRE(std::holds_alternative<File>(result));
		return std::move(std::get<File>(result));
	}

	std::array<std::byte, 5> hello()
	{
		return {std::byte{'h'}, std::byte{'e'}, std::byte{'l'}, std::byte{'l'}, std::byte{'o'}};
	}
}

TEST_CASE("makeIoBuffer is 1 MiB")
{
	CHECK(makeIoBuffer().size() == 1024 * 1024);
}

TEST_CASE("createExclusive writes, close succeeds, and the bytes are on disk")
{
	const TempDir dir;
	const fs::path path = dir.path() / "out.bin";
	File file = mustCreate(path);
	CHECK(file.isOpen());
	const auto data = hello();
	CHECK_FALSE(file.write(data).has_value());
	CHECK_FALSE(file.close().has_value());
	CHECK_FALSE(file.isOpen());
	CHECK(fs::file_size(path) == 5);
}

TEST_CASE("createExclusive fails when the file already exists and leaves it alone")
{
	const TempDir dir;
	const fs::path path = dir.makeFile("exists.bin", 7);
	const auto result = File::createExclusive(path);
	REQUIRE(std::holds_alternative<IoError>(result));
	CHECK(fs::file_size(path) == 7);
}

TEST_CASE("createExclusive fails in a missing directory")
{
	const TempDir dir;
	const auto result = File::createExclusive(dir.path() / "missing" / "out.bin");
	CHECK(std::holds_alternative<IoError>(result));
}

TEST_CASE("openRead reads in chunks and reports end of file with 0")
{
	const TempDir dir;
	const fs::path path = dir.makeFile("in.bin", 2500);
	File file = mustOpen(path);
	std::array<std::byte, 1000> buffer{};
	std::size_t total = 0;
	std::size_t calls = 0;
	for (;;)
	{
		const auto result = file.read(buffer);
		REQUIRE(std::holds_alternative<std::size_t>(result));
		const std::size_t count = std::get<std::size_t>(result);
		if (count == 0)
		{
			break;
		}
		CHECK(std::all_of(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(count), [](std::byte b)
		{
			return b == std::byte{'x'};
		}));
		total += count;
		++calls;
	}
	CHECK(total == 2500);
	CHECK(calls == 3);
	CHECK_FALSE(file.close().has_value());
}

TEST_CASE("openRead fails for a missing file")
{
	const TempDir dir;
	const auto result = File::openRead(dir.path() / "missing.bin");
	CHECK(std::holds_alternative<IoError>(result));
}

TEST_CASE("close is idempotent and I/O after close is an error, not a crash")
{
	const TempDir dir;
	File file = mustCreate(dir.path() / "out.bin");
	CHECK_FALSE(file.close().has_value());
	CHECK_FALSE(file.close().has_value());
	const auto data = hello();
	CHECK(file.write(data).has_value());
	std::array<std::byte, 4> buffer{};
	CHECK(std::holds_alternative<IoError>(file.read(buffer)));
}

TEST_CASE("writing to a file opened for reading reports an error")
{
	const TempDir dir;
	const fs::path path = dir.makeFile("in.bin", 10);
	File file = mustOpen(path);
	const auto data = hello();
	// The stdio buffer may accept a small write; the error must surface by close() at the latest.
	const bool writeFailed = file.write(data).has_value();
	const bool closeFailed = file.close().has_value();
	CHECK((writeFailed || closeFailed));
}

TEST_CASE("the destructor closes the file")
{
	const TempDir dir;
	const fs::path path = dir.path() / "out.bin";
	{
		File file = mustCreate(path);
		const auto data = hello();
		CHECK_FALSE(file.write(data).has_value());
	}
	CHECK(fs::file_size(path) == 5);
}

TEST_CASE("a moved-from File is closed and the new owner works")
{
	const TempDir dir;
	File first = mustCreate(dir.path() / "out.bin");
	File second = std::move(first);
	CHECK_FALSE(first.isOpen());
	CHECK(second.isOpen());
	const auto data = hello();
	CHECK_FALSE(second.write(data).has_value());
	CHECK_FALSE(second.close().has_value());
}

TEST_CASE("removeQuietly removes a file and ignores a missing one")
{
	const TempDir dir;
	const fs::path path = dir.makeFile("partial.bin", 3);
	removeQuietly(path);
	CHECK_FALSE(fs::exists(path));
	removeQuietly(path);
	removeQuietly(dir.path() / "never-existed");
}

TEST_CASE("size measures the open file and leaves the position at the start")
{
	const TempDir dir;
	const fs::path path = dir.makeFile("sized.bin", 3000);
	File file = mustOpen(path);
	const auto size = file.size();
	REQUIRE(std::holds_alternative<std::uint64_t>(size));
	CHECK(std::get<std::uint64_t>(size) == 3000);
	Buffer buffer = makeIoBuffer();
	const auto read = file.read(buffer);
	REQUIRE(std::holds_alternative<std::size_t>(read));
	CHECK(std::get<std::size_t>(read) == 3000);
}

TEST_CASE("only a file made by createExclusive counts as created by this process")
{
	const TempDir dir;
	File created = mustCreate(dir.path() / "new.bin");
	CHECK(created.createdByThisProcess());
	File opened = mustOpen(dir.makeFile("existing.bin", 1));
	CHECK_FALSE(opened.createdByThisProcess());
	File moved = std::move(created);
	CHECK(moved.createdByThisProcess());
}

TEST_CASE("empty reads and writes do nothing and succeed")
{
	const TempDir dir;
	File out = mustCreate(dir.path() / "empty.bin");
	CHECK_FALSE(out.write(std::span<const std::byte>{}).has_value());
	CHECK_FALSE(out.close().has_value());
	CHECK(fs::file_size(dir.path() / "empty.bin") == 0);

	File in = mustOpen(dir.makeFile("one.bin", 1));
	const auto read = in.read(std::span<std::byte>{});
	REQUIRE(std::holds_alternative<std::size_t>(read));
	CHECK(std::get<std::size_t>(read) == 0);
	std::array<std::byte, 4> buffer{};
	const auto after = in.read(buffer);
	REQUIRE(std::holds_alternative<std::size_t>(after));
	CHECK(std::get<std::size_t>(after) == 1);
}
