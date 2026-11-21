#include <doctest/doctest.h>

#include <filesystem>
#include <string>
#include <system_error>
#include <variant>

#include "projecto/paths.hpp"
#include "temp_dir.hpp"

using namespace projecto;
using projecto::testing::TempDir;
namespace fs = std::filesystem;

namespace
{
	using PathResult = std::variant<fs::path, PathError>;

	bool isPath(const PathResult& result)
	{
		return std::holds_alternative<fs::path>(result);
	}

	// ExitCode::usage unless stated otherwise.
	bool isRuleError(const PathResult& result)
	{
		const PathError* error = std::get_if<PathError>(&result);
		return error != nullptr && error->code == ExitCode::usage;
	}

	// Tries to create a symlink; returns false (and the caller skips) where the platform refuses.
	bool makeSymlink(const fs::path& target, const fs::path& link)
	{
		std::error_code ec;
		fs::create_symlink(target, link, ec);
		if (ec)
		{
			MESSAGE("symlinks are not available here: " << ec.message());
			return false;
		}
		return true;
	}
}

TEST_CASE("validateInput rejects an input with a second hard link")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.bin", 10);
	std::error_code ec;
	fs::create_hard_link(input, dir.path() / "other-name.bin", ec);
	if (ec)
	{
		MESSAGE("hard links are not available here: " << ec.message());
		return;
	}
	const PathResult result = validateInput(dir.path(), input, 10);
	REQUIRE(isRuleError(result));
	CHECK(std::get<PathError>(result).message.find("hard link") != std::string::npos);

	fs::remove(dir.path() / "other-name.bin");
	CHECK(isPath(validateInput(dir.path(), input, 10)));
}

TEST_CASE("validateRoot accepts an absolute directory and returns it canonical")
{
	const TempDir dir;
	fs::create_directories(dir.path() / "sub");
	const PathResult plain = validateRoot(dir.path());
	REQUIRE(isPath(plain));
	CHECK(std::get<fs::path>(plain) == dir.path());

	const PathResult dotted = validateRoot(dir.path() / "sub" / "..");
	REQUIRE(isPath(dotted));
	CHECK(std::get<fs::path>(dotted) == dir.path());
}

TEST_CASE("validateRoot rejects a relative path")
{
	CHECK(isRuleError(validateRoot(fs::path{"relative"})));
	CHECK(isRuleError(validateRoot(fs::path{})));
}

TEST_CASE("validateRoot rejects a missing path and a regular file")
{
	const TempDir dir;
	CHECK(isRuleError(validateRoot(dir.path() / "missing")));
	const fs::path file = dir.makeFile("plain.bin", 4);
	CHECK(isRuleError(validateRoot(file)));
}

TEST_CASE("validateRoot rejects a symlink to a directory, with or without a trailing separator")
{
	const TempDir dir;
	fs::create_directories(dir.path() / "real");
	if (!makeSymlink(dir.path() / "real", dir.path() / "link"))
	{
		return;
	}
	CHECK(isRuleError(validateRoot(dir.path() / "link")));
	CHECK(isRuleError(validateRoot(dir.path() / "link" / "")));
}

TEST_CASE("validateRoot resolves .. after a symlink the way the OS does, not lexically")
{
	const TempDir dir;
	fs::create_directories(dir.path() / "real" / "sub");
	if (!makeSymlink(dir.path() / "real" / "sub", dir.path() / "link"))
	{
		return;
	}
	// link/.. is real (the parent of the link's target), while a lexical reading gives dir itself.
	const PathResult resolved = validateRoot(dir.path() / "link" / "..");
	REQUIRE(isPath(resolved));
	CHECK(std::get<fs::path>(resolved) == fs::canonical(dir.path() / "real"));
	CHECK(std::get<fs::path>(resolved) != dir.path());
}

TEST_CASE("validateInput accepts a regular file directly under the root")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 100);
	const PathResult result = validateInput(dir.path(), input, 100);
	REQUIRE(isPath(result));
	CHECK(std::get<fs::path>(result) == dir.path() / "in.stl");
}

TEST_CASE("validateInput rejects a relative path")
{
	const TempDir dir;
	dir.makeFile("in.stl", 10);
	CHECK(isRuleError(validateInput(dir.path(), fs::path{"in.stl"}, 10)));
}

TEST_CASE("validateInput rejects a symlink to a regular file inside the root")
{
	const TempDir dir;
	const fs::path real = dir.makeFile("real.stl", 10);
	if (!makeSymlink(real, dir.path() / "link.stl"))
	{
		return;
	}
	CHECK(isRuleError(validateInput(dir.path(), dir.path() / "link.stl", 10)));
}

TEST_CASE("validateInput rejects a dangling symlink")
{
	const TempDir dir;
	if (!makeSymlink(dir.path() / "nowhere", dir.path() / "dangling.stl"))
	{
		return;
	}
	CHECK(isRuleError(validateInput(dir.path(), dir.path() / "dangling.stl", 10)));
}

TEST_CASE("validateInput rejects a missing file and a directory")
{
	const TempDir dir;
	CHECK(isRuleError(validateInput(dir.path(), dir.path() / "missing.stl", 10)));
	fs::create_directories(dir.path() / "folder");
	CHECK(isRuleError(validateInput(dir.path(), dir.path() / "folder", 10)));
	CHECK(isRuleError(validateInput(dir.path(), dir.path() / "folder" / "", 10)));
}

TEST_CASE("validateInput rejects a file outside the root")
{
	const TempDir root;
	const TempDir other;
	const fs::path outside = other.makeFile("in.stl", 10);
	CHECK(isRuleError(validateInput(root.path(), outside, 10)));
}

TEST_CASE("validateInput rejects a file in a subdirectory of the root (direct children only)")
{
	const TempDir dir;
	fs::create_directories(dir.path() / "sub");
	const fs::path nested = dir.makeFile("sub/in.stl", 10);
	CHECK(isRuleError(validateInput(dir.path(), nested, 10)));
}

TEST_CASE("validateInput rejects a path that climbs out of the root with ..")
{
	const TempDir dir;
	const fs::path root = dir.path() / "jail";
	fs::create_directories(root);
	dir.makeFile("secret.bin", 10);
	CHECK(isRuleError(validateInput(root, root / ".." / "secret.bin", 10)));
}

TEST_CASE("validateInput rejects a directory reached through a symlinked parent")
{
	const TempDir dir;
	const TempDir other;
	other.makeFile("in.stl", 10);
	const fs::path root = dir.path() / "jail";
	fs::create_directories(root);
	if (!makeSymlink(other.path(), root / "escape"))
	{
		return;
	}
	CHECK(isRuleError(validateInput(root, root / "escape" / "in.stl", 10)));
}

TEST_CASE("validateInput requires the exact size")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 100);
	CHECK(isRuleError(validateInput(dir.path(), input, 99)));
	CHECK(isRuleError(validateInput(dir.path(), input, 101)));
	CHECK(isRuleError(validateInput(dir.path(), input, 0)));
	CHECK(isPath(validateInput(dir.path(), input, 100)));
}

TEST_CASE("validateOutput accepts a new name directly under the root")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 10);
	const PathResult result = validateOutput(dir.path(), input, dir.path() / "out.zst");
	REQUIRE(isPath(result));
	CHECK(std::get<fs::path>(result) == dir.path() / "out.zst");
	CHECK_FALSE(fs::exists(dir.path() / "out.zst"));
}

TEST_CASE("validateOutput rejects a relative path")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 10);
	CHECK(isRuleError(validateOutput(dir.path(), input, fs::path{"out.zst"})));
}

TEST_CASE("validateOutput rejects an existing file")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 10);
	const fs::path existing = dir.makeFile("out.zst", 1);
	CHECK(isRuleError(validateOutput(dir.path(), input, existing)));
}

TEST_CASE("validateOutput rejects a dangling symlink as existing")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 10);
	if (!makeSymlink(dir.path() / "nowhere", dir.path() / "out.zst"))
	{
		return;
	}
	CHECK(isRuleError(validateOutput(dir.path(), input, dir.path() / "out.zst")));
}

TEST_CASE("validateOutput rejects the input's own path and its file name")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 10);
	const PathResult same = validateOutput(dir.path(), input, input);
	REQUIRE(isRuleError(same));
	CHECK(std::get<PathError>(same).message.find("different file name") != std::string::npos);
}

TEST_CASE("validateOutput rejects a path outside the root, in a subdirectory, or in a missing directory")
{
	const TempDir dir;
	const TempDir other;
	const fs::path input = dir.makeFile("in.stl", 10);
	CHECK(isRuleError(validateOutput(dir.path(), input, other.path() / "out.zst")));
	fs::create_directories(dir.path() / "sub");
	CHECK(isRuleError(validateOutput(dir.path(), input, dir.path() / "sub" / "out.zst")));
	CHECK(isRuleError(validateOutput(dir.path(), input, dir.path() / "missing" / "out.zst")));
	CHECK(isRuleError(validateOutput(dir.path(), input, dir.path() / ".." / "out.zst")));
}

TEST_CASE("validateOutput rejects a name-less path")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 10);
	CHECK(isRuleError(validateOutput(dir.path(), input, dir.path() / "")));
	CHECK(isRuleError(validateOutput(dir.path(), input, dir.path() / "..")));
}

TEST_CASE("validatePaths returns canonical paths for a valid request")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 64);
	Options options;
	options.root = dir.path();
	options.input = input;
	options.output = dir.path() / "out.zst";
	options.inputSize = 64;
	const auto result = validatePaths(options);
	REQUIRE(std::holds_alternative<ValidatedPaths>(result));
	const ValidatedPaths& paths = std::get<ValidatedPaths>(result);
	CHECK(paths.root == dir.path());
	CHECK(paths.input == dir.path() / "in.stl");
	CHECK(paths.output == dir.path() / "out.zst");
}

TEST_CASE("validatePaths reports the first failing rule with a usage code")
{
	const TempDir dir;
	const fs::path input = dir.makeFile("in.stl", 64);
	Options options;
	options.root = dir.path();
	options.input = input;
	options.output = dir.path() / "out.zst";
	options.inputSize = 65;
	const auto result = validatePaths(options);
	REQUIRE(std::holds_alternative<PathError>(result));
	CHECK(std::get<PathError>(result).code == ExitCode::usage);
}

TEST_CASE("validateOutput reports an unreadable parent directory as I/O (exit 3), not a usage error")
{
	const TempDir dir;
	const fs::path locked = dir.path() / "locked";
	fs::create_directories(locked / "sub");
	fs::permissions(locked, fs::perms::none);
	std::error_code ec;
	const bool blocked = !fs::exists(fs::canonical(locked / "sub", ec)) && ec == std::errc::permission_denied;
	if (blocked)
	{
		const PathResult result = validateOutput(dir.path(), dir.path() / "in.bin", locked / "sub" / "out.bin");
		REQUIRE(std::holds_alternative<PathError>(result));
		CHECK(std::get<PathError>(result).code == ExitCode::io);
	}
	else
	{
		MESSAGE("permissions are not enforced here (running as root?): nothing to check");
	}
	fs::permissions(locked, fs::perms::owner_all);
}
