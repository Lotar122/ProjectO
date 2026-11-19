#include <doctest/doctest.h>

#include <filesystem>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "projecto/app.hpp"
#include "projecto/exit_code.hpp"
#include "temp_dir.hpp"

using namespace projecto;
using projecto::testing::TempDir;
namespace fs = std::filesystem;

namespace
{
	struct Run
	{
		ExitCode code;
		std::string out;
		std::string err;
	};

	Run run(const std::vector<std::string>& tokens)
	{
		const std::vector<std::string_view> views(tokens.begin(), tokens.end());
		std::ostringstream out;
		std::ostringstream err;
		const ExitCode code = runApp(views, out, err);
		return Run{code, out.str(), err.str()};
	}

	std::vector<std::string> compressArgs(const TempDir& dir, const std::string& codec, const std::string& size)
	{
		return {
			"compress",
			"--codec", codec,
			"--root", dir.path().string(),
			"--input", (dir.path() / "in.stl").string(),
			"--output", (dir.path() / "out.bin").string(),
			"--input-size", size,
		};
	}
}

TEST_CASE("--version prints one version line and exits 0")
{
	const Run result = run({"--version"});
	CHECK(result.code == ExitCode::ok);
	CHECK(result.out == "{\"type\":\"version\",\"version\":\"1.0.0\",\"zstd\":\"1.5.7\",\"brotli\":\"1.2.1\"}\n");
	CHECK(result.err.empty());
}

TEST_CASE("a usage error prints a result line on stdout, a message on stderr, and exits 2")
{
	const Run result = run({"compress", "--codec", "gzip"});
	CHECK(result.code == ExitCode::usage);
	CHECK(result.out.starts_with("{\"type\":\"result\",\"ok\":false,\"error\":\"usage\""));
	CHECK(result.err.find("--codec") != std::string::npos);
}

TEST_CASE("a path rule violation exits 2 and creates nothing")
{
	const TempDir dir;
	dir.makeFile("in.stl", 10);
	const Run result = run(compressArgs(dir, "zstd", "11"));
	CHECK(result.code == ExitCode::usage);
	CHECK(result.out.find("--input-size") != std::string::npos);
	CHECK_FALSE(fs::exists(dir.path() / "out.bin"));
}

TEST_CASE("compress with valid arguments writes the output and ends with an ok result line")
{
	for (const char* codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir dir;
		dir.makeFile("in.stl", 10);
		const Run result = run(compressArgs(dir, codec, "10"));
		CHECK(result.code == ExitCode::ok);
		CHECK(result.out.starts_with("{\"type\":\"start\",\"codec\":\"" + std::string{codec} + "\""));
		CHECK(result.out.find("{\"type\":\"result\",\"ok\":true,\"codec\":\"" + std::string{codec} + "\"") != std::string::npos);
		CHECK(fs::exists(dir.path() / "out.bin"));
	}
}

TEST_CASE("every stdout line is a single JSON object line within 4 KiB")
{
	const Run result = run({"compress"});
	CHECK(result.out.size() <= 4096);
	CHECK(result.out.front() == '{');
	CHECK(result.out.substr(result.out.size() - 2) == "}\n");
}
