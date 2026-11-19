#include <doctest/doctest.h>

#include <algorithm>
#include <cstddef>
#include <sstream>
#include <stdexcept>
#include <string>

#include "projecto/exit_code.hpp"
#include "projecto/protocol.hpp"
#include "projecto/version.hpp"

using namespace projecto;
using namespace std::string_literals;

TEST_CASE("escapeJson escapes quotes, backslashes and control characters")
{
	CHECK(escapeJson("plain") == "plain");
	CHECK(escapeJson("a\"b") == "a\\\"b");
	CHECK(escapeJson("a\\b") == "a\\\\b");
	CHECK(escapeJson("l1\nl2\r\t") == "l1\\nl2\\r\\t");
	CHECK(escapeJson("\b\f") == "\\b\\f");
	CHECK(escapeJson("\x01\x1f"s) == "\\u0001\\u001f");
	CHECK(escapeJson("a\0b"s) == "a\\u0000b");
	CHECK(escapeJson("/") == "/");
}

TEST_CASE("escapeJson passes valid UTF-8 through")
{
	CHECK(escapeJson("caf\xC3\xA9") == "caf\xC3\xA9");
	CHECK(escapeJson("\xE2\x82\xAC") == "\xE2\x82\xAC");
	CHECK(escapeJson("\xF0\x9F\x98\x80") == "\xF0\x9F\x98\x80");
}

TEST_CASE("escapeJson replaces invalid UTF-8 with U+FFFD")
{
	CHECK(escapeJson("a\xFF" "b") == "a\\ufffdb");
	CHECK(escapeJson("\x80") == "\\ufffd");
	CHECK(escapeJson("\xC3") == "\\ufffd");
	CHECK(escapeJson("\xC0\xAF") == "\\ufffd\\ufffd");
	CHECK(escapeJson("\xED\xA0\x80") == "\\ufffd\\ufffd\\ufffd");
	CHECK(escapeJson("\xF4\x90\x80\x80") == "\\ufffd\\ufffd\\ufffd\\ufffd");
	CHECK(escapeJson("\xE2\x82") == "\\ufffd\\ufffd");
}

TEST_CASE("escapeJson never cuts inside a character or an escape")
{
	CHECK(escapeJson("abcdef", 3) == "abc");
	CHECK(escapeJson("ab\xC3\xA9", 3) == "ab");
	CHECK(escapeJson("ab\"", 3) == "ab");
	CHECK(escapeJson("ab\"", 4) == "ab\\\"");
	CHECK(escapeJson("anything", 0).empty());
}

TEST_CASE("JsonLine writes one object per line with fixed keys")
{
	JsonLine line{"progress"};
	line.number("read", 67108864).number("written", 9437184);
	CHECK(line.str() == "{\"type\":\"progress\",\"read\":67108864,\"written\":9437184}\n");
}

TEST_CASE("JsonLine supports booleans, null and the largest 64-bit number")
{
	JsonLine line{"start"};
	line.boolean("ldm", true).boolean("flag", false).null("estimatedBytes").number("big", 18446744073709551615ULL);
	CHECK(line.str() == "{\"type\":\"start\",\"ldm\":true,\"flag\":false,\"estimatedBytes\":null,\"big\":18446744073709551615}\n");
}

TEST_CASE("JsonLine escapes string values")
{
	JsonLine line{"result"};
	line.text("message", "path \"C:\\x\"\nnext");
	CHECK(line.str() == "{\"type\":\"result\",\"message\":\"path \\\"C:\\\\x\\\"\\nnext\"}\n");
}

TEST_CASE("a hostile message cannot break out of its string or the line")
{
	const std::string line = errorResult(ExitCode::usage, "x\",\"ok\":true,\"y\":\"\n{\"type\":\"result\"").str();
	CHECK(std::count(line.begin(), line.end(), '\n') == 1);
	CHECK(line.back() == '\n');
	CHECK(line.find("\"ok\":true") == std::string::npos);
}

TEST_CASE("a long message is truncated and the line stays within 4 KiB")
{
	const std::string huge(100000, 'a');
	const std::string line = errorResult(ExitCode::io, huge).str();
	CHECK(line.size() <= kMaxLineBytes);
	CHECK(line.back() == '\n');
	CHECK(line.find("\"message\":\"aaa") != std::string::npos);

	const std::string quotes(100000, '"');
	CHECK(errorResult(ExitCode::io, quotes).str().size() <= kMaxLineBytes);
}

TEST_CASE("a line built from too many fields is refused instead of emitted")
{
	JsonLine line{"x"};
	const std::string chunk(kMaxTextBytes, 'b');
	line.text("a", chunk).text("b", chunk).text("c", chunk);
	CHECK_THROWS_AS(line.str(), std::length_error);
}

TEST_CASE("errorResult uses the documented error names")
{
	CHECK(errorResult(ExitCode::usage, "m").str() == "{\"type\":\"result\",\"ok\":false,\"error\":\"usage\",\"message\":\"m\"}\n");
	CHECK(errorResult(ExitCode::io, "m").str().find("\"error\":\"io\"") != std::string::npos);
	CHECK(errorResult(ExitCode::budget, "m").str().find("\"error\":\"memory_budget\"") != std::string::npos);
	CHECK(errorResult(ExitCode::codec, "m").str().find("\"error\":\"codec\"") != std::string::npos);
	CHECK(errorResult(ExitCode::internal, "m").str().find("\"error\":\"internal\"") != std::string::npos);
}

TEST_CASE("exit codes keep their documented values")
{
	CHECK(toInt(ExitCode::ok) == 0);
	CHECK(toInt(ExitCode::usage) == 2);
	CHECK(toInt(ExitCode::io) == 3);
	CHECK(toInt(ExitCode::budget) == 4);
	CHECK(toInt(ExitCode::codec) == 5);
	CHECK(toInt(ExitCode::internal) == 70);
}

TEST_CASE("writeLine writes the line to the stream")
{
	std::ostringstream out;
	CHECK(writeLine(out, JsonLine{"progress"}.number("read", 1)));
	CHECK(out.str() == "{\"type\":\"progress\",\"read\":1}\n");
}

TEST_CASE("writeLine reports a stream that cannot be written")
{
	std::ostringstream out;
	out.setstate(std::ios::badbit);
	CHECK_FALSE(writeLine(out, JsonLine{"progress"}.number("read", 1)));
}

TEST_CASE("versionLine reports the pinned library versions")
{
	CHECK(versionLine().str() == "{\"type\":\"version\",\"version\":\"1.0.0\",\"zstd\":\"1.5.7\",\"brotli\":\"1.2.1\"}\n");
	CHECK_FALSE(checkLibraryVersions().has_value());
}
