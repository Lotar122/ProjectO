#include <doctest/doctest.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <sstream>
#include <string>
#include <variant>
#include <vector>

#include <zstd.h>

#include "projecto/brotli_codec.hpp"
#include "projecto/budget_allocator.hpp"
#include "projecto/codec_common.hpp"
#include "projecto/exit_code.hpp"
#include "projecto/zstd_codec.hpp"
#include "temp_dir.hpp"
#include "test_support.hpp"

using namespace projecto;
using namespace projecto::testing;
namespace fs = std::filesystem;

namespace
{
	constexpr std::uint64_t MiB = std::uint64_t{1} << 20;

	struct Fixture
	{
		std::string name;
		Bytes data;
	};

	std::vector<Fixture> fixtures()
	{
		std::vector<Fixture> list;
		list.push_back({"1 B", Bytes{std::byte{'x'}}});
		list.push_back({"4 KiB text", textLike(4096)});
		list.push_back({"8 MiB STL-like", stlLike(8 * MiB, 1)});
		list.push_back({"256 KiB random", randomBytes(256 * 1024, 2)});
		return list;
	}

	std::optional<Bytes> decode(std::string_view codec, const Bytes& encoded)
	{
		return codec == "zstd" ? decodeZstd(encoded, 28) : decodeBrotli(encoded, true);
	}

	// Writes data as in.bin under dir and runs compress into out.bin.
	AppRun compressFile(const TempDir& dir, std::string_view codec, const Bytes& data, std::vector<std::string> extra = {})
	{
		writeBytes(dir.path() / "in.bin", data);
		std::vector<std::string> args = compressArgs(codec, dir.path(), "in.bin", "out.bin", data.size());
		args.insert(args.end(), extra.begin(), extra.end());
		return runCompressor(args);
	}

	// The start line with its budgetBytes field removed.
	std::string withoutBudget(const std::string& line)
	{
		const std::size_t at = line.find(",\"budgetBytes\":");
		return line.substr(0, at);
	}

	CompressRequest requestFor(const TempDir& dir, std::uint64_t inputSize, std::uint64_t budgetBytes)
	{
		CompressRequest request;
		request.input = dir.path() / "in.bin";
		request.output = dir.path() / "out.bin";
		request.inputSize = inputSize;
		request.budgetBytes = budgetBytes;
		return request;
	}

	// 64 MiB of one repeated 1 MiB STL block: the same parameters and tables as any
	// 64 MiB input (peak memory depends on them, not on the content), compressed in seconds.
	Bytes repeated64MiB()
	{
		const Bytes block = stlLike(MiB, 3);
		Bytes data;
		data.reserve(64 * MiB);
		for (int copy = 0; copy < 64; ++copy)
		{
			data.insert(data.end(), block.begin(), block.end());
		}
		return data;
	}
}

TEST_CASE("both codecs round-trip 1 B, 4 KiB text, 8 MiB STL-like and random input")
{
	for (const Fixture& fixture : fixtures())
	{
		for (const std::string codec : {"zstd", "br"})
		{
			CAPTURE(fixture.name);
			CAPTURE(codec);
			const TempDir dir;
			const AppRun run = compressFile(dir, codec, fixture.data);
			REQUIRE(run.code == ExitCode::ok);
			const std::optional<std::string> result = lineOfType(run.out, "result");
			REQUIRE(result.has_value());
			CHECK(textField(*result, "codec") == codec);
			CHECK(numberField(*result, "inputSize") == fixture.data.size());

			const Bytes encoded = readBytes(dir.path() / "out.bin");
			CHECK(numberField(*result, "outputSize") == encoded.size());
			const std::optional<std::uint64_t> peak = numberField(*result, "peakBytes");
			REQUIRE(peak.has_value());
			CHECK(*peak > 0);
			CHECK(*peak <= 6144 * MiB);
			CHECK(numberField(*result, "elapsedMs").has_value());
			const std::string expectedEncoder = codec == "zstd" ? "projecto-compress/1.0.0 zstd/1.5.7"
															   : "projecto-compress/1.0.0 brotli/1.2.1";
			CHECK(textField(*result, "encoder") == expectedEncoder);

			const std::optional<Bytes> decoded = decode(codec, encoded);
			REQUIRE(decoded.has_value());
			CHECK(*decoded == fixture.data);
		}
	}
}

TEST_CASE("zstd frames carry the content size and a checksum")
{
	const TempDir dir;
	const Bytes data = textLike(100'000);
	REQUIRE(compressFile(dir, "zstd", data).code == ExitCode::ok);
	const Bytes encoded = readBytes(dir.path() / "out.bin");
	ZSTD_FrameHeader header{};
	REQUIRE(ZSTD_getFrameHeader(&header, encoded.data(), encoded.size()) == 0);
	CHECK(header.frameContentSize == data.size());
	CHECK(header.checksumFlag == 1U);
	CHECK(ZSTD_findFrameCompressedSize(encoded.data(), encoded.size()) == encoded.size());
}

TEST_CASE("brotli up to 16 MiB is a standard stream: it decodes without the large-window flag")
{
	const TempDir dir;
	const Bytes data = stlLike(300 * 1024, 4);
	REQUIRE(compressFile(dir, "br", data).code == ExitCode::ok);
	const std::optional<Bytes> decoded = decodeBrotli(readBytes(dir.path() / "out.bin"), false);
	REQUIRE(decoded.has_value());
	CHECK(*decoded == data);
}

TEST_CASE("an empty input is rejected before anything runs")
{
	for (const std::string codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir dir;
		const AppRun run = compressFile(dir, codec, Bytes{});
		CHECK(run.code == ExitCode::usage);
		CHECK_FALSE(fs::exists(dir.path() / "out.bin"));
	}
}

TEST_CASE("over budget is exit 4 before the output exists, with the full parameters in the start line")
{
	// 8 MiB: zstd needs 141.5 MiB and brotli 314.3 MiB, both over 64 MiB.
	const Bytes data = stlLike(8 * MiB, 5);
	for (const std::string codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir dir;
		const AppRun run = compressFile(dir, codec, data, {"--memory-budget-mib", "64"});
		CHECK(run.code == ExitCode::budget);
		CHECK_FALSE(fs::exists(dir.path() / "out.bin"));
		const std::optional<std::string> result = lineOfType(run.out, "result");
		REQUIRE(result.has_value());
		CHECK(result->find("\"ok\":false,\"error\":\"memory_budget\"") != std::string::npos);
		CHECK(lineOfType(run.out, "progress") == std::nullopt);

		const std::optional<std::string> start = lineOfType(run.out, "start");
		REQUIRE(start.has_value());
		CHECK(numberField(*start, "budgetBytes") == 64 * MiB);
		if (codec == "zstd")
		{
			// Same values as the plan for 8 MiB: the budget lowered nothing.
			CHECK(numberField(*start, "windowLog") == 23);
			CHECK(numberField(*start, "chainLog") == 24);
			CHECK(numberField(*start, "hashLog") == 24);
			CHECK(numberField(*start, "estimatedBytes") == planZstd(8 * MiB, 28).estimatedBytes);
		}
		else
		{
			CHECK(numberField(*start, "lgwin") == 23);
			CHECK(numberField(*start, "estimatedBytes") == planBrotli(8 * MiB, 28).estimatedBytes);
		}
	}
}

TEST_CASE("the budget never changes the parameters or the output (6144 vs 7168 MiB)")
{
	const Bytes data = stlLike(300 * 1024, 6);
	for (const std::string codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir low;
		const TempDir high;
		const AppRun lowRun = compressFile(low, codec, data, {"--memory-budget-mib", "6144"});
		const AppRun highRun = compressFile(high, codec, data, {"--memory-budget-mib", "7168"});
		REQUIRE(lowRun.code == ExitCode::ok);
		REQUIRE(highRun.code == ExitCode::ok);
		const std::optional<std::string> lowStart = lineOfType(lowRun.out, "start");
		const std::optional<std::string> highStart = lineOfType(highRun.out, "start");
		REQUIRE(lowStart.has_value());
		REQUIRE(highStart.has_value());
		CHECK(withoutBudget(*lowStart) == withoutBudget(*highStart));
		CHECK(numberField(*lowStart, "budgetBytes") == 6144 * MiB);
		CHECK(numberField(*highStart, "budgetBytes") == 7168 * MiB);
		CHECK(readBytes(low.path() / "out.bin") == readBytes(high.path() / "out.bin"));
	}
}

TEST_CASE("the allocator is a hard cap at run time: exit 4 and the output is removed")
{
	// encode* skips the estimate check, so the refusal comes from the allocator after the
	// output was created (the tables are allocated on the first compress call).
	const TempDir dir;
	const Bytes data = stlLike(2 * MiB, 7);
	writeBytes(dir.path() / "in.bin", data);
	const CompressRequest request = requestFor(dir, data.size(), MiB);

	std::ostringstream out;
	ProgressReporter zstdProgress{out, MiB};
	BudgetAllocator zstdAllocator{request.budgetBytes};
	const CompressOutcome zstdOutcome = encodeZstd(planZstd(data.size(), 28).params, request, zstdProgress, zstdAllocator);
	REQUIRE(std::holds_alternative<CodecFailure>(zstdOutcome));
	CHECK(std::get<CodecFailure>(zstdOutcome).code == ExitCode::budget);
	CHECK_FALSE(fs::exists(request.output));

	ProgressReporter brotliProgress{out, MiB};
	BudgetAllocator brotliAllocator{request.budgetBytes};
	const CompressOutcome brotliOutcome = encodeBrotli(planBrotli(data.size(), 28), request, brotliProgress, brotliAllocator);
	REQUIRE(std::holds_alternative<CodecFailure>(brotliOutcome));
	CHECK(std::get<CodecFailure>(brotliOutcome).code == ExitCode::budget);
	CHECK_FALSE(fs::exists(request.output));
}

TEST_CASE("an input whose size differs from --input-size is exit 3 and leaves no output")
{
	const TempDir dir;
	const Bytes data = textLike(10'000);
	writeBytes(dir.path() / "in.bin", data);
	for (const std::uint64_t claimed : {data.size() - 1, data.size() + 1})
	{
		CAPTURE(claimed);
		const CompressRequest request = requestFor(dir, claimed, 6144 * MiB);
		std::ostringstream out;
		ProgressReporter progress{out, MiB};
		BudgetAllocator allocator{request.budgetBytes};
		const CompressOutcome zstdOutcome = encodeZstd(planZstd(claimed, 28).params, request, progress, allocator);
		REQUIRE(std::holds_alternative<CodecFailure>(zstdOutcome));
		CHECK(std::get<CodecFailure>(zstdOutcome).code == ExitCode::io);
		CHECK_FALSE(fs::exists(request.output));
		const CompressOutcome brotliOutcome = encodeBrotli(planBrotli(claimed, 28), request, progress, allocator);
		REQUIRE(std::holds_alternative<CodecFailure>(brotliOutcome));
		CHECK(std::get<CodecFailure>(brotliOutcome).code == ExitCode::io);
		CHECK_FALSE(fs::exists(request.output));
	}
}

TEST_CASE("InputReader stops at exactly the expected size and reports a longer or shorter file")
{
	const TempDir dir;
	writeBytes(dir.path() / "in.bin", textLike(3000));

	auto exact = InputReader::open(dir.path() / "in.bin", 3000);
	REQUIRE(std::holds_alternative<InputReader>(exact));
	InputReader& reader = std::get<InputReader>(exact);
	const auto chunk = reader.next();
	REQUIRE(std::holds_alternative<std::span<const std::byte>>(chunk));
	CHECK(std::get<std::span<const std::byte>>(chunk).size() == 3000);
	const auto end = reader.next();
	REQUIRE(std::holds_alternative<std::span<const std::byte>>(end));
	CHECK(std::get<std::span<const std::byte>>(end).empty());

	const auto shorter = InputReader::open(dir.path() / "in.bin", 2999);
	REQUIRE(std::holds_alternative<CodecFailure>(shorter));
	CHECK(std::get<CodecFailure>(shorter).code == ExitCode::io);
	const auto longer = InputReader::open(dir.path() / "in.bin", 3001);
	REQUIRE(std::holds_alternative<CodecFailure>(longer));
	CHECK(std::get<CodecFailure>(longer).code == ExitCode::io);
}

TEST_CASE("OutputFile removes its file unless committed, and never touches a file it did not create")
{
	const TempDir dir;
	const fs::path path = dir.path() / "out.bin";
	{
		auto created = OutputFile::create(path);
		REQUIRE(std::holds_alternative<OutputFile>(created));
		const Bytes data = textLike(100);
		CHECK_FALSE(std::get<OutputFile>(created).write(data).has_value());
		CHECK(fs::exists(path));
	}
	CHECK_FALSE(fs::exists(path));

	{
		auto created = OutputFile::create(path);
		REQUIRE(std::holds_alternative<OutputFile>(created));
		OutputFile moved = std::move(std::get<OutputFile>(created));
		CHECK_FALSE(moved.write(textLike(10)).has_value());
		CHECK_FALSE(moved.commit().has_value());
		CHECK(moved.written() == 10);
	}
	REQUIRE(fs::exists(path));
	CHECK(fs::file_size(path) == 10);

	// Someone else's file at the path: create fails and the file stays as it was.
	const auto clash = OutputFile::create(path);
	REQUIRE(std::holds_alternative<CodecFailure>(clash));
	CHECK(std::get<CodecFailure>(clash).code == ExitCode::io);
	CHECK(fs::file_size(path) == 10);
}

TEST_CASE("progress lines come every interval, in order, before the result line")
{
	const TempDir dir;
	const Bytes data = stlLike(3 * MiB + 100, 8);
	const AppRun run = compressFile(dir, "zstd", data, {"--progress-interval-mib", "1"});
	REQUIRE(run.code == ExitCode::ok);
	const std::vector<std::string> lines = splitLines(run.out);
	REQUIRE(lines.size() == 5);
	CHECK(lines.front().starts_with("{\"type\":\"start\""));
	CHECK(lines.back().starts_with("{\"type\":\"result\",\"ok\":true"));
	const std::vector<std::uint64_t> expected{MiB, 2 * MiB, 3 * MiB};
	for (std::size_t index = 0; index < expected.size(); ++index)
	{
		const std::string& line = lines[index + 1];
		CAPTURE(line);
		CHECK(line.starts_with("{\"type\":\"progress\""));
		CHECK(numberField(line, "read") == expected[index]);
		CHECK(numberField(line, "written").has_value());
	}
	CHECK(std::ranges::all_of(lines, [](const std::string& line)
	{
		return line.size() < 4096;
	}));
}

TEST_CASE("64 MiB: peakBytes stays within the budget, the zstd estimate + 5%, and the brotli estimate")
{
	const Bytes data = repeated64MiB();
	for (const std::string codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const TempDir dir;
		writeBytes(dir.path() / "in.bin", data);
		const CompressRequest request = requestFor(dir, data.size(), 6144 * MiB);
		BudgetAllocator allocator{request.budgetBytes};
		std::ostringstream out;
		ProgressReporter progress{out, 64 * MiB};
		std::uint64_t estimate = 0;
		CompressOutcome outcome;
		if (codec == "zstd")
		{
			const ZstdPlan plan = planZstd(data.size(), 28);
			estimate = plan.estimatedBytes;
			outcome = encodeZstd(plan.params, request, progress, allocator);
		}
		else
		{
			const BrotliPlan plan = planBrotli(data.size(), 28);
			REQUIRE(plan.estimatedBytes.has_value());
			estimate = *plan.estimatedBytes;
			outcome = encodeBrotli(plan, request, progress, allocator);
		}
		REQUIRE(std::holds_alternative<CompressStats>(outcome));
		const std::uint64_t peak = std::get<CompressStats>(outcome).peakBytes;
		MESSAGE(codec << " 64 MiB: peakBytes " << peak << ", estimatedBytes " << estimate << ", peak live blocks "
			<< allocator.peakBlocks());
		CHECK(peak == allocator.peak());
		CHECK(peak <= request.budgetBytes);
		if (codec == "zstd")
		{
			CHECK(peak * 100 <= estimate * 105);
		}
		else
		{
			// Regression guard: the brotli pre-check is only sound while the estimate covers the peak.
			CHECK(peak <= estimate);
		}
		// The header allowance in fitsBudget covers every live block's header.
		CHECK(allocator.peakBlocks() <= BudgetAllocator::kAllowedLiveBlocks);
		const std::optional<Bytes> decoded = decode(codec, readBytes(dir.path() / "out.bin"));
		REQUIRE(decoded.has_value());
		CHECK(*decoded == data);
	}
}

TEST_CASE("an estimate that fits the budget only without the block headers is refused before any output")
{
	const TempDir dir;
	const Bytes data = textLike(1024);
	writeBytes(dir.path() / "in.bin", data);
	const std::uint64_t zstdEstimate = planZstd(data.size(), 28).estimatedBytes;
	const std::optional<std::uint64_t> brotliEstimate = planBrotli(data.size(), 28).estimatedBytes;
	REQUIRE(brotliEstimate.has_value());
	for (const std::string codec : {"zstd", "br"})
	{
		CAPTURE(codec);
		const std::uint64_t estimate = codec == "zstd" ? zstdEstimate : *brotliEstimate;
		for (const std::uint64_t budget : {estimate, estimate + BudgetAllocator::kHeaderAllowanceBytes - 1})
		{
			CAPTURE(budget);
			CompressRequest request = requestFor(dir, data.size(), budget);
			std::ostringstream out;
			const CompressOutcome outcome = codec == "zstd" ? compressZstd(request, out) : compressBrotli(request, out);
			REQUIRE(std::holds_alternative<CodecFailure>(outcome));
			CHECK(std::get<CodecFailure>(outcome).code == ExitCode::budget);
			CHECK_FALSE(fs::exists(request.output));
		}
		CompressRequest request = requestFor(dir, data.size(), estimate + BudgetAllocator::kHeaderAllowanceBytes);
		std::ostringstream out;
		const CompressOutcome outcome = codec == "zstd" ? compressZstd(request, out) : compressBrotli(request, out);
		REQUIRE(std::holds_alternative<CompressStats>(outcome));
		CHECK(std::get<CompressStats>(outcome).peakBytes <= request.budgetBytes);
		fs::remove(request.output);
	}
}

TEST_CASE("an allocation refused after output bytes were written: brotli exits 4 and removes the output")
{
	// The progress listener drops the budget to what is live as soon as output exists, so the
	// next allocation is refused mid-stream, with a partial output file on disk. A q11 metablock
	// can grow to 2^min(lgwin + 1, 24) bytes before anything is written, so the window is capped
	// at 18: output then starts after about 512 KiB and every later metablock allocates again.
	const TempDir dir;
	const Bytes data = stlLike(4 * MiB, 12);
	writeBytes(dir.path() / "in.bin", data);
	const CompressRequest request = requestFor(dir, data.size(), 6144 * MiB);
	BudgetAllocator allocator{request.budgetBytes};
	std::uint64_t writtenWhenLowered = 0;
	std::uint64_t readWhenLowered = 0;
	std::ostringstream out;
	ProgressReporter progress{out, MiB, [&](std::uint64_t read, std::uint64_t written)
	{
		if (written > 0 && writtenWhenLowered == 0)
		{
			writtenWhenLowered = written;
			readWhenLowered = read;
			CHECK(fs::exists(request.output));
			allocator.setBudget(allocator.current());
		}
	}};
	const CompressOutcome outcome = encodeBrotli(planBrotli(data.size(), 18), request, progress, allocator);
	CHECK(writtenWhenLowered > 0);
	// Mid-stream: most of the input was still unread when the budget dropped.
	CHECK(readWhenLowered < data.size() / 2);
	REQUIRE(std::holds_alternative<CodecFailure>(outcome));
	CHECK(std::get<CodecFailure>(outcome).code == ExitCode::budget);
	CHECK(allocator.refused());
	CHECK_FALSE(fs::exists(request.output));
}

TEST_CASE("zstd allocates its whole workspace before the first output byte, so it cannot be refused mid-stream")
{
	// The counterpart of the brotli case: with the budget dropped to what is live once output
	// exists, zstd still finishes, because it makes no allocation after its first call.
	const TempDir dir;
	const Bytes data = stlLike(8 * MiB, 12);
	writeBytes(dir.path() / "in.bin", data);
	const CompressRequest request = requestFor(dir, data.size(), 6144 * MiB);
	BudgetAllocator allocator{request.budgetBytes};
	bool lowered = false;
	std::ostringstream out;
	ProgressReporter progress{out, MiB, [&allocator, &lowered](std::uint64_t, std::uint64_t written)
	{
		if (written > 0 && !lowered)
		{
			lowered = true;
			allocator.setBudget(allocator.current());
		}
	}};
	const CompressOutcome outcome = encodeZstd(planZstd(data.size(), 28).params, request, progress, allocator);
	CHECK(lowered);
	REQUIRE(std::holds_alternative<CompressStats>(outcome));
	CHECK_FALSE(allocator.refused());
	const std::optional<Bytes> decoded = decodeZstd(readBytes(request.output), 28);
	REQUIRE(decoded.has_value());
	CHECK(*decoded == data);
}

TEST_CASE("large: a 129 MiB input uses zstd window 28, which needs ZSTD_d_windowLogMax = 28 to decode")
{
	if (!largeTestsEnabled())
	{
		return;
	}
	const TempDir dir;
	const Bytes data = stlLike(129 * MiB, 9);
	const AppRun run = compressFile(dir, "zstd", data);
	REQUIRE(run.code == ExitCode::ok);
	const std::optional<std::string> start = lineOfType(run.out, "start");
	REQUIRE(start.has_value());
	CHECK(numberField(*start, "windowLog") == 28);
	CHECK(numberField(*start, "chainLog") == 29);
	const std::optional<std::string> result = lineOfType(run.out, "result");
	REQUIRE(result.has_value());
	MESSAGE("zstd 129 MiB: " << *result);

	const Bytes encoded = readBytes(dir.path() / "out.bin");
	const std::optional<Bytes> decoded = decodeZstd(encoded, 28);
	REQUIRE(decoded.has_value());
	CHECK(*decoded == data);
	CHECK_FALSE(decodeZstd(encoded, 0).has_value());
}

TEST_CASE("large: brotli at 17 MiB is large-window (needs the decoder flag), at 16 MiB it is standard")
{
	if (!largeTestsEnabled())
	{
		return;
	}
	{
		const TempDir dir;
		const Bytes data = stlLike(17 * MiB, 10);
		const AppRun run = compressFile(dir, "br", data);
		REQUIRE(run.code == ExitCode::ok);
		const std::optional<std::string> start = lineOfType(run.out, "start");
		REQUIRE(start.has_value());
		CHECK(numberField(*start, "lgwin") == 25);
		CHECK(start->find("\"largeWindow\":true") != std::string::npos);
		const Bytes encoded = readBytes(dir.path() / "out.bin");
		const std::optional<Bytes> decoded = decodeBrotli(encoded, true);
		REQUIRE(decoded.has_value());
		CHECK(*decoded == data);
		CHECK_FALSE(decodeBrotli(encoded, false).has_value());
	}
	{
		const TempDir dir;
		const Bytes data = stlLike(16 * MiB, 11);
		const AppRun run = compressFile(dir, "br", data);
		REQUIRE(run.code == ExitCode::ok);
		const std::optional<std::string> start = lineOfType(run.out, "start");
		REQUIRE(start.has_value());
		CHECK(numberField(*start, "lgwin") == 24);
		CHECK(start->find("\"largeWindow\":false") != std::string::npos);
		const std::optional<Bytes> decoded = decodeBrotli(readBytes(dir.path() / "out.bin"), false);
		REQUIRE(decoded.has_value());
		CHECK(*decoded == data);
	}
}
