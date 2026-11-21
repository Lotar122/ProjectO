#include <doctest/doctest.h>

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <ostream>
#include <sstream>
#include <streambuf>
#include <string>
#include <string_view>
#include <vector>

#include "projecto/app.hpp"
#include "projecto/exit_code.hpp"
#include "projecto/pending_outputs.hpp"
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

	// Accepts the first `lines` lines, then fails every write, like a pipe whose reader left.
	class LineLimitBuffer : public std::streambuf
	{
	public:
		explicit LineLimitBuffer(std::size_t lines)
			: left_(lines)
		{
		}

		const std::string& text() const noexcept
		{
			return text_;
		}

	protected:
		int_type overflow(int_type ch) override
		{
			if (traits_type::eq_int_type(ch, traits_type::eof()))
			{
				return traits_type::not_eof(ch);
			}
			if (left_ == 0)
			{
				return traits_type::eof();
			}
			const char c = traits_type::to_char_type(ch);
			text_.push_back(c);
			if (c == '\n')
			{
				--left_;
			}
			return ch;
		}

	private:
		std::size_t left_;
		std::string text_;
	};

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

TEST_CASE("a result line that cannot be written exits 3 but keeps the complete output")
{
	for (const char* codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir dir;
		dir.makeFile("in.stl", 10);
		const std::vector<std::string> tokens = compressArgs(dir, codec, "10");
		const std::vector<std::string_view> views(tokens.begin(), tokens.end());
		LineLimitBuffer buffer{1};
		std::ostream out{&buffer};
		std::ostringstream err;
		const ExitCode code = runApp(views, out, err);
		CHECK(code == ExitCode::io);
		CHECK(buffer.text().starts_with("{\"type\":\"start\""));
		CHECK(err.str().find("result line") != std::string::npos);
		// The failed success line is not followed by an error line, and stderr names the failure once.
		CHECK(buffer.text().find("\"type\":\"result\"") == std::string::npos);
		const std::string errText = err.str();
		CHECK(std::count(errText.begin(), errText.end(), '\n') == 1);
		REQUIRE(fs::exists(dir.path() / "out.bin"));
		CHECK(fs::file_size(dir.path() / "out.bin") > 0);
	}
}

TEST_CASE("a closed stdin after the output is committed keeps the file and the exit code")
{
	for (const char* codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir dir;
		dir.makeFile("in.stl", 10);
		PendingOutputs& pending = PendingOutputs::instance();
		// The registry is process-wide and earlier tests may have committed through it, so the
		// mark is cleared first: whatever ran before, only this run can set it again.
		pending.resetFinishedForTesting();
		// Before the run, a closed stdin would stop it (nothing is pending yet, so nothing is removed).
		CHECK(pending.removeAllAndFreezeUnlessFinished().has_value());

		const Run result = run(compressArgs(dir, codec, "10"));
		REQUIRE(result.code == ExitCode::ok);
		REQUIRE(fs::exists(dir.path() / "out.bin"));

		// What the stdin watch does at end of file: after a committed run it declines to stop.
		CHECK_FALSE(pending.removeAllAndFreezeUnlessFinished().has_value());
		CHECK(fs::exists(dir.path() / "out.bin"));
	}
}

TEST_CASE("a failed run does not mark the run finished")
{
	const TempDir dir;
	dir.makeFile("in.stl", 10);
	PendingOutputs& pending = PendingOutputs::instance();
	pending.resetFinishedForTesting();

	// The size does not match, so nothing is committed.
	const Run result = run(compressArgs(dir, "zstd", "11"));
	REQUIRE(result.code == ExitCode::usage);

	CHECK(pending.removeAllAndFreezeUnlessFinished().has_value());
}

TEST_CASE("--watch-stdin 1 starts the watch before any file is touched")
{
	const TempDir dir;
	dir.makeFile("in.stl", 10);
	std::vector<std::string> tokens = compressArgs(dir, "zstd", "10");
	tokens.insert(tokens.end(), {"--watch-stdin", "1"});
	const std::vector<std::string_view> views(tokens.begin(), tokens.end());

	int started = 0;
	{
		std::ostringstream out;
		std::ostringstream err;
		const ExitCode code = runApp(views, out, err, [&started]() -> std::optional<std::string>
		{
			++started;
			return std::nullopt;
		});
		CHECK(code == ExitCode::ok);
		CHECK(started == 1);
	}

	fs::remove(dir.path() / "out.bin");
	{
		std::ostringstream out;
		std::ostringstream err;
		const ExitCode code = runApp(views, out, err, []() -> std::optional<std::string>
		{
			return "no threads";
		});
		CHECK(code == ExitCode::internal);
		CHECK(err.str().find("no threads") != std::string::npos);
		CHECK_FALSE(fs::exists(dir.path() / "out.bin"));
	}

	{
		std::ostringstream out;
		std::ostringstream err;
		CHECK(runApp(views, out, err) == ExitCode::internal);
		CHECK_FALSE(fs::exists(dir.path() / "out.bin"));
	}

	// Without the flag the starter is never called.
	const std::vector<std::string> plain = compressArgs(dir, "zstd", "10");
	const std::vector<std::string_view> plainViews(plain.begin(), plain.end());
	std::ostringstream out;
	std::ostringstream err;
	CHECK(runApp(plainViews, out, err, [&started]() -> std::optional<std::string>
	{
		++started;
		return std::nullopt;
	}) == ExitCode::ok);
	CHECK(started == 1);
}

TEST_CASE("every stdout line is a single JSON object line within 4 KiB")
{
	const Run result = run({"compress"});
	CHECK(result.out.size() <= 4096);
	CHECK(result.out.front() == '{');
	CHECK(result.out.substr(result.out.size() - 2) == "}\n");
}
