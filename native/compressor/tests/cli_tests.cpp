#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "projecto/cli.hpp"

using namespace projecto;

namespace
{
	const std::string kRoot = std::filesystem::absolute("projecto-root").string();

	std::vector<std::string> validTokens()
	{
		const std::filesystem::path root = kRoot;
		return {
			"compress",
			"--codec", "zstd",
			"--root", root.string(),
			"--input", (root / "in.stl").string(),
			"--output", (root / "out.zst").string(),
			"--input-size", "1000",
		};
	}

	ParseResult parse(const std::vector<std::string>& tokens)
	{
		const std::vector<std::string_view> views(tokens.begin(), tokens.end());
		return parseOptions(views);
	}

	std::vector<std::string> withFlag(std::vector<std::string> tokens, const std::string& flag, const std::string& value)
	{
		for (std::size_t i = 1; i + 1 < tokens.size(); i += 2)
		{
			if (tokens[i] == flag)
			{
				tokens[i + 1] = value;
				return tokens;
			}
		}
		tokens.push_back(flag);
		tokens.push_back(value);
		return tokens;
	}

	bool isUsageError(const ParseResult& result)
	{
		return std::holds_alternative<UsageError>(result);
	}

	const Options& asOptions(const ParseResult& result)
	{
		REQUIRE(std::holds_alternative<Options>(result));
		return std::get<Options>(result);
	}
}

TEST_CASE("--version alone is a version request")
{
	const std::vector<std::string> tokens{"--version"};
	CHECK(std::holds_alternative<VersionRequest>(parse(tokens)));
}

TEST_CASE("--version with anything else is a usage error")
{
	CHECK(isUsageError(parse({"--version", "compress"})));
	CHECK(isUsageError(parse({"--version", "--version"})));
	CHECK(isUsageError(parse({"compress", "--version"})));
}

TEST_CASE("a missing or unknown subcommand is a usage error")
{
	CHECK(isUsageError(parse({})));
	CHECK(isUsageError(parse({"decompress"})));
	CHECK(isUsageError(parse({"Compress"})));
	CHECK(isUsageError(parse({"--codec", "zstd"})));
}

TEST_CASE("a complete valid command line parses with the documented defaults")
{
	const ParseResult result = parse(validTokens());
	const Options& options = asOptions(result);
	CHECK(options.codec == Codec::zstd);
	CHECK(options.inputSize == 1000);
	CHECK(options.memoryBudgetMib == 6144);
	CHECK(options.maxWindowLog == 28);
	CHECK(options.progressIntervalMib == 64);
	CHECK(options.input.filename() == "in.stl");
	CHECK(options.output.filename() == "out.zst");
}

TEST_CASE("--codec accepts exactly zstd or br")
{
	CHECK(asOptions(parse(withFlag(validTokens(), "--codec", "zstd"))).codec == Codec::zstd);
	CHECK(asOptions(parse(withFlag(validTokens(), "--codec", "br"))).codec == Codec::br);
	for (const char* bad : {"gzip", "ZSTD", "Br", "brotli", "zstd ", " zstd", "zstd,br", ""})
	{
		CAPTURE(bad);
		CHECK(isUsageError(parse(withFlag(validTokens(), "--codec", bad))));
	}
}

TEST_CASE("--root, --input and --output must be absolute paths")
{
	for (const char* flag : {"--root", "--input", "--output"})
	{
		for (const char* bad : {"relative/path", "file.bin", "./file.bin", "../file.bin", ""})
		{
			CAPTURE(flag);
			CAPTURE(bad);
			CHECK(isUsageError(parse(withFlag(validTokens(), flag, bad))));
		}
	}
}

TEST_CASE("--input-size is a whole decimal number between 1 and 2^30")
{
	CHECK(asOptions(parse(withFlag(validTokens(), "--input-size", "1"))).inputSize == 1);
	CHECK(asOptions(parse(withFlag(validTokens(), "--input-size", "1073741824"))).inputSize == 1073741824ULL);
	CHECK(asOptions(parse(withFlag(validTokens(), "--input-size", "0042"))).inputSize == 42);

	const std::array<const char*, 14> bad{
		"0", "1073741825", "4294967296", "12a", "a12", "-1", "+5", "", " 5", "5 ",
		"1.5", "0x10", "1e3", "99999999999999999999999999",
	};
	for (const char* token : bad)
	{
		CAPTURE(token);
		CHECK(isUsageError(parse(withFlag(validTokens(), "--input-size", token))));
	}
}

TEST_CASE("--memory-budget-mib is 64 to 7168, default 6144")
{
	CHECK(asOptions(parse(withFlag(validTokens(), "--memory-budget-mib", "64"))).memoryBudgetMib == 64);
	CHECK(asOptions(parse(withFlag(validTokens(), "--memory-budget-mib", "7168"))).memoryBudgetMib == 7168);
	for (const char* bad : {"63", "0", "7169", "4294967296", "abc", "-64", "64.0", ""})
	{
		CAPTURE(bad);
		CHECK(isUsageError(parse(withFlag(validTokens(), "--memory-budget-mib", bad))));
	}
}

TEST_CASE("--max-window-log is 10 to 28, default 28")
{
	CHECK(asOptions(parse(withFlag(validTokens(), "--max-window-log", "10"))).maxWindowLog == 10);
	CHECK(asOptions(parse(withFlag(validTokens(), "--max-window-log", "28"))).maxWindowLog == 28);
	for (const char* bad : {"9", "0", "29", "30", "27x", "-1", ""})
	{
		CAPTURE(bad);
		CHECK(isUsageError(parse(withFlag(validTokens(), "--max-window-log", bad))));
	}
}

TEST_CASE("--progress-interval-mib is 1 to 1024, default 64")
{
	CHECK(asOptions(parse(withFlag(validTokens(), "--progress-interval-mib", "1"))).progressIntervalMib == 1);
	CHECK(asOptions(parse(withFlag(validTokens(), "--progress-interval-mib", "1024"))).progressIntervalMib == 1024);
	for (const char* bad : {"0", "1025", "x", "-1", ""})
	{
		CAPTURE(bad);
		CHECK(isUsageError(parse(withFlag(validTokens(), "--progress-interval-mib", bad))));
	}
}

TEST_CASE("an unknown flag is a usage error")
{
	std::vector<std::string> tokens = validTokens();
	tokens.push_back("--threads");
	tokens.push_back("4");
	CHECK(isUsageError(parse(tokens)));
}

TEST_CASE("the --flag=value form is not accepted")
{
	std::vector<std::string> tokens = validTokens();
	tokens[1] = "--codec=zstd";
	tokens.erase(tokens.begin() + 2, tokens.begin() + 4);
	CHECK(isUsageError(parse(tokens)));
}

TEST_CASE("a stray positional argument is a usage error")
{
	std::vector<std::string> tokens = validTokens();
	tokens.push_back("extra");
	CHECK(isUsageError(parse(tokens)));
}

TEST_CASE("every flag given twice is a usage error")
{
	const std::vector<std::pair<std::string, std::string>> flags{
		{"--codec", "br"},
		{"--root", kRoot},
		{"--input", kRoot + "/a"},
		{"--output", kRoot + "/b"},
		{"--input-size", "5"},
		{"--memory-budget-mib", "128"},
		{"--max-window-log", "20"},
		{"--progress-interval-mib", "2"},
	};
	for (const auto& [flag, value] : flags)
	{
		CAPTURE(flag);
		std::vector<std::string> tokens = validTokens();
		tokens.push_back(flag);
		tokens.push_back(value);
		const bool alreadyPresent = std::find(tokens.begin(), tokens.end() - 2, flag) != tokens.end() - 2;
		if (!alreadyPresent)
		{
			// Optional flag: the first occurrence must be valid, the second is the duplicate.
			CHECK(std::holds_alternative<Options>(parse(tokens)));
			tokens.push_back(flag);
			tokens.push_back(value);
		}
		CHECK(isUsageError(parse(tokens)));
	}
}

TEST_CASE("every required flag missing is a usage error")
{
	for (const char* flag : {"--codec", "--root", "--input", "--output", "--input-size"})
	{
		CAPTURE(flag);
		std::vector<std::string> tokens = validTokens();
		for (std::size_t i = 1; i + 1 < tokens.size(); i += 2)
		{
			if (tokens[i] == flag)
			{
				tokens.erase(tokens.begin() + static_cast<std::ptrdiff_t>(i), tokens.begin() + static_cast<std::ptrdiff_t>(i) + 2);
				break;
			}
		}
		CHECK(isUsageError(parse(tokens)));
	}
}

TEST_CASE("a flag without a value is a usage error")
{
	for (const char* flag : {"--codec", "--root", "--input", "--output", "--input-size"})
	{
		CAPTURE(flag);
		std::vector<std::string> tokens = validTokens();
		const auto at = std::find(tokens.begin(), tokens.end(), std::string{flag});
		REQUIRE(at != tokens.end());
		tokens.erase(at, at + 2);
		tokens.push_back(flag);
		CHECK(isUsageError(parse(tokens)));
	}
	std::vector<std::string> optional = validTokens();
	optional.push_back("--memory-budget-mib");
	CHECK(isUsageError(parse(optional)));
}

TEST_CASE("a usage error names the offending flag")
{
	const ParseResult result = parse(withFlag(validTokens(), "--memory-budget-mib", "7169"));
	REQUIRE(isUsageError(result));
	CHECK(std::get<UsageError>(result).message.find("--memory-budget-mib") != std::string::npos);
}
