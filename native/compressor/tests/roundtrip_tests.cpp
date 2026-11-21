#include <doctest/doctest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <thread>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>
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
	const CompressOutcome zstdOutcome = encodeZstd(planZstd(data.size(), 28), 0, request, zstdProgress, zstdAllocator);
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
		const CompressOutcome zstdOutcome = encodeZstd(planZstd(claimed, 28), 4, request, progress, allocator);
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

TEST_CASE("InputReader checks the open handle: a second hard link or a symlink is refused")
{
	const TempDir dir;
	writeBytes(dir.path() / "in.bin", textLike(3000));
	std::error_code ec;
	fs::create_hard_link(dir.path() / "in.bin", dir.path() / "twin.bin", ec);
	if (ec)
	{
		MESSAGE("hard links are not available here: " << ec.message());
	}
	else
	{
		// The link appeared after validation would have passed: the handle check still sees it.
		const auto linked = InputReader::open(dir.path() / "in.bin", 3000);
		REQUIRE(std::holds_alternative<CodecFailure>(linked));
		CHECK(std::get<CodecFailure>(linked).code == ExitCode::io);
		CHECK(std::get<CodecFailure>(linked).message.find("hard links") != std::string::npos);
		fs::remove(dir.path() / "twin.bin");
	}

	fs::create_symlink(dir.path() / "in.bin", dir.path() / "link.bin", ec);
	if (ec)
	{
		MESSAGE("symlinks are not available here: " << ec.message());
		return;
	}
	const auto symlinked = InputReader::open(dir.path() / "link.bin", 3000);
	REQUIRE(std::holds_alternative<CodecFailure>(symlinked));
	CHECK(std::get<CodecFailure>(symlinked).code == ExitCode::io);
}

TEST_CASE("File::inspect measures the open handle: type, links and a 64-bit size")
{
	const TempDir dir;
	writeBytes(dir.path() / "in.bin", textLike(4321));
	auto opened = File::openRead(dir.path() / "in.bin");
	REQUIRE(std::holds_alternative<File>(opened));
	const auto facts = std::get<File>(opened).inspect();
	REQUIRE(std::holds_alternative<FileFacts>(facts));
	CHECK(std::get<FileFacts>(facts).regular);
	CHECK(std::get<FileFacts>(facts).links == 1);
	CHECK(std::get<FileFacts>(facts).size == 4321);
}

TEST_CASE("File::sync puts written bytes on storage, and on a closed file it is an error")
{
	const TempDir dir;
	const fs::path path = dir.path() / "synced.bin";
	auto created = File::createExclusive(path);
	REQUIRE(std::holds_alternative<File>(created));
	File& file = std::get<File>(created);
	CHECK_FALSE(file.write(textLike(64)).has_value());
	CHECK_FALSE(file.sync().has_value());
	CHECK_FALSE(file.close().has_value());
	CHECK(file.sync().has_value());
	CHECK(fs::file_size(path) == 64);
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
	// Single-threaded the input is read as it is compressed, so the lines fall exactly on the interval.
	const TempDir dir;
	const Bytes data = stlLike(3 * MiB + 100, 8);
	const AppRun run = compressFile(dir, "zstd", data, {"--progress-interval-mib", "1", "--threads", "1"});
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

TEST_CASE("with workers, progress counts compressed input: increasing, one line per interval passed, before the result")
{
	const TempDir dir;
	const Bytes data = stlLike(3 * MiB + 100, 8);
	const AppRun run = compressFile(dir, "zstd", data, {"--progress-interval-mib", "1", "--threads", "4"});
	REQUIRE(run.code == ExitCode::ok);
	const std::vector<std::string> lines = splitLines(run.out);
	REQUIRE(lines.size() >= 3);
	CHECK(lines.front().find("\"workers\":4") != std::string::npos);
	CHECK(lines.back().starts_with("{\"type\":\"result\",\"ok\":true"));
	std::uint64_t previousRead = 0;
	std::uint64_t previousWritten = 0;
	for (std::size_t index = 1; index + 1 < lines.size(); ++index)
	{
		const std::string& line = lines[index];
		CAPTURE(line);
		REQUIRE(line.starts_with("{\"type\":\"progress\""));
		const std::optional<std::uint64_t> read = numberField(line, "read");
		const std::optional<std::uint64_t> written = numberField(line, "written");
		REQUIRE(read.has_value());
		REQUIRE(written.has_value());
		// Each line passed a new multiple of the interval.
		CHECK(*read / MiB > previousRead / MiB);
		CHECK(*read <= data.size());
		CHECK(*written >= previousWritten);
		previousRead = *read;
		previousWritten = *written;
	}
	// The last line reports the whole input compressed.
	CHECK(previousRead == data.size());
}

TEST_CASE("64 MiB: peakBytes stays within the budget, the single-threaded zstd estimate + 5%, and the brotli estimate")
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
			outcome = encodeZstd(plan, 0, request, progress, allocator);
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
	// Reporting the refusal took it, so it cannot be blamed for a later error as well.
	CHECK(allocator.lastFailure() == AllocationFailure::none);
	CHECK_FALSE(fs::exists(request.output));
}

TEST_CASE("single-threaded zstd allocates its whole workspace before the first output byte, so it cannot be refused mid-stream")
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
	const CompressOutcome outcome = encodeZstd(planZstd(data.size(), 28), 0, request, progress, allocator);
	CHECK(lowered);
	REQUIRE(std::holds_alternative<CompressStats>(outcome));
	CHECK_FALSE(allocator.refused());
	const std::optional<Bytes> decoded = decodeZstd(readBytes(request.output), 28);
	REQUIRE(decoded.has_value());
	CHECK(*decoded == data);
}

namespace
{
	// 3 MiB of text, 4 MiB of STL-like data and 1 MiB of noise: 8 MiB in 8 jobs of 1 MiB.
	Bytes mixed8MiB()
	{
		Bytes data = textLike(3 * MiB);
		const Bytes stl = stlLike(4 * MiB, 21);
		const Bytes noise = randomBytes(MiB, 22);
		data.insert(data.end(), stl.begin(), stl.end());
		data.insert(data.end(), noise.begin(), noise.end());
		return data;
	}

	std::uint64_t ceilMiB(std::uint64_t bytes)
	{
		return (bytes + MiB - 1) / MiB;
	}
}

TEST_CASE("zstd round-trips with --threads 1 and --threads 4, and multi-MiB inputs run on several workers")
{
	struct Case
	{
		std::string name;
		Bytes data;
		// Workers --threads 4 gets: min(4, jobs), or 0 for a single job.
		std::uint64_t workersAtFour;
	};
	std::vector<Case> cases;
	cases.push_back({"300 KiB text (one job)", textLike(300 * 1024), 0});
	cases.push_back({"3 MiB + 100 B STL-like (7 jobs)", stlLike(3 * MiB + 100, 23), 4});
	cases.push_back({"8 MiB mixed (8 jobs)", mixed8MiB(), 4});
	for (const Case& entry : cases)
	{
		for (const std::uint64_t threads : {1U, 4U})
		{
			CAPTURE(entry.name);
			CAPTURE(threads);
			const TempDir dir;
			const AppRun run = compressFile(dir, "zstd", entry.data, {"--threads", std::to_string(threads)});
			REQUIRE(run.code == ExitCode::ok);
			const std::uint64_t expected = threads == 1 ? 0 : entry.workersAtFour;
			const std::optional<std::string> start = lineOfType(run.out, "start");
			REQUIRE(start.has_value());
			CHECK(numberField(*start, "threads") == threads);
			CHECK(numberField(*start, "workers") == expected);
			const std::optional<std::string> result = lineOfType(run.out, "result");
			REQUIRE(result.has_value());
			CHECK(numberField(*result, "workers") == expected);
			MESSAGE(entry.name << " --threads " << threads << ": " << *result);

			const Bytes encoded = readBytes(dir.path() / "out.bin");
			ZSTD_FrameHeader header{};
			REQUIRE(ZSTD_getFrameHeader(&header, encoded.data(), encoded.size()) == 0);
			CHECK(header.frameContentSize == entry.data.size());
			CHECK(header.checksumFlag == 1U);
			CHECK(header.windowSize <= (std::uint64_t{1} << 28));
			CHECK(ZSTD_findFrameCompressedSize(encoded.data(), encoded.size()) == encoded.size());
			const std::optional<Bytes> decoded = decodeZstd(encoded, 28);
			REQUIRE(decoded.has_value());
			CHECK(*decoded == entry.data);
		}
	}
}

TEST_CASE("multithreaded zstd output depends on the job layout only: 2 and 4 workers give the same bytes")
{
	const Bytes data = stlLike(3 * MiB + 100, 24);
	const TempDir two;
	const TempDir four;
	REQUIRE(compressFile(two, "zstd", data, {"--threads", "2"}).code == ExitCode::ok);
	REQUIRE(compressFile(four, "zstd", data, {"--threads", "4"}).code == ExitCode::ok);
	CHECK(readBytes(two.path() / "out.bin") == readBytes(four.path() / "out.bin"));
}

TEST_CASE("multithreaded encodeZstd: nbWorkers is applied, jobs run in parallel, peakBytes stays within the estimate")
{
	struct Case
	{
		std::string name;
		Bytes data;
		int workers;
	};
	std::vector<Case> cases;
	cases.push_back({"8 MiB mixed", mixed8MiB(), 4});
	cases.push_back({"8 MiB mixed", mixed8MiB(), 2});
	cases.push_back({"64 MiB repeated", repeated64MiB(), 2});
	for (const Case& entry : cases)
	{
		CAPTURE(entry.name);
		CAPTURE(entry.workers);
		const TempDir dir;
		writeBytes(dir.path() / "in.bin", entry.data);
		const CompressRequest request = requestFor(dir, entry.data.size(), 6144 * MiB);
		const ZstdPlan plan = planZstd(entry.data.size(), 28);
		REQUIRE(plan.jobs.count >= static_cast<std::uint64_t>(entry.workers));
		const std::uint64_t estimate = zstdEstimate(plan, entry.workers);
		BudgetAllocator allocator{request.budgetBytes};
		std::ostringstream out;
		ProgressReporter progress{out, 64 * MiB};
		const std::clock_t cpuStarted = std::clock();
		const auto wallStarted = std::chrono::steady_clock::now();
		const CompressOutcome outcome = encodeZstd(plan, entry.workers, request, progress, allocator);
		const double cpuSeconds = static_cast<double>(std::clock() - cpuStarted) / CLOCKS_PER_SEC;
		const double wallSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - wallStarted).count();
		REQUIRE(std::holds_alternative<CompressStats>(outcome));
		const CompressStats& stats = std::get<CompressStats>(outcome);
		MESSAGE(entry.name << " with " << entry.workers << " workers: peakBytes " << stats.peakBytes << ", estimate "
			<< estimate << " (single-threaded " << plan.estimatedBytes << "), jobs in flight " << stats.peakActiveWorkers
			<< ", peak live blocks " << allocator.peakBlocks() << ", CPU " << cpuSeconds << " s in " << wallSeconds
			<< " s wall");
		CHECK(stats.workers == static_cast<std::uint64_t>(entry.workers));
		// zstd reports jobs in flight only in MT mode (0 single-threaded): several jobs were handed out.
		CHECK(stats.peakActiveWorkers >= 2);
		// Running, plus one queued and one cut but not yet posted.
		CHECK(stats.peakActiveWorkers <= static_cast<std::uint64_t>(entry.workers) + 2);
		// The process used clearly more CPU time than wall time: the workers really ran side by side.
		if (std::thread::hardware_concurrency() >= 2)
		{
			CHECK(cpuSeconds > wallSeconds * 1.25);
		}
		CHECK(stats.peakBytes <= estimate);
		CHECK(stats.peakBytes > plan.estimatedBytes);
		CHECK(allocator.peakBlocks() <= BudgetAllocator::kAllowedLiveBlocks);
		CHECK(allocator.current() == 0);
		const std::optional<Bytes> decoded = decodeZstd(readBytes(request.output), 28);
		REQUIRE(decoded.has_value());
		CHECK(*decoded == entry.data);
	}
}

TEST_CASE("multithreaded zstd: a worker's allocation refused mid-run is exit 4, every worker stops, the output is removed")
{
	// The budget holds the shared state and one worker's context, not a second one: the first job
	// runs, the second job's worker is refused its context after the output was created.
	const TempDir dir;
	const Bytes data = mixed8MiB();
	writeBytes(dir.path() / "in.bin", data);
	const ZstdPlan plan = planZstd(data.size(), 28);
	const CompressRequest request = requestFor(dir, data.size(), zstdEstimate(plan, 1));
	REQUIRE(request.budgetBytes < zstdEstimate(plan, 2));
	BudgetAllocator allocator{request.budgetBytes};
	bool outputSeen = false;
	std::ostringstream out;
	ProgressReporter progress{out, MiB, [&request, &outputSeen](std::uint64_t, std::uint64_t)
	{
		outputSeen = outputSeen || fs::exists(request.output);
	}};
	const auto started = std::chrono::steady_clock::now();
	const CompressOutcome outcome = encodeZstd(plan, 4, request, progress, allocator);
	const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started);
	MESSAGE("refused run returned after " << elapsed.count() << " ms");
	CHECK(outputSeen);
	REQUIRE(std::holds_alternative<CodecFailure>(outcome));
	CHECK(std::get<CodecFailure>(outcome).code == ExitCode::budget);
	CHECK_FALSE(fs::exists(request.output));
	// The context was freed, so every worker has finished and returned all its memory.
	CHECK(allocator.current() == 0);
	CHECK(allocator.peak() <= request.budgetBytes);
	CHECK(allocator.lastFailure() == AllocationFailure::none);
}

namespace
{
	// A system allocator that runs out of memory on demand: allocations of at least
	// gSystemMinBytes use up one of gSystemAllowed and fail (nullptr) once none are left;
	// smaller ones always succeed. zstd workers call it from their own threads.
	std::atomic<std::uint64_t> gSystemMinBytes = 0;
	std::atomic<std::uint64_t> gSystemAllowed = 0;
	std::atomic<std::uint64_t> gSystemRefused = 0;

	void* exhaustibleMalloc(std::size_t bytes) noexcept
	{
		if (bytes >= gSystemMinBytes.load())
		{
			std::uint64_t left = gSystemAllowed.load();
			do
			{
				if (left == 0)
				{
					gSystemRefused.fetch_add(1);
					return nullptr;
				}
			}
			while (!gSystemAllowed.compare_exchange_weak(left, left - 1));
		}
		return std::malloc(bytes);
	}

	void resetExhaustibleMalloc(std::uint64_t minBytes, std::uint64_t allowed)
	{
		gSystemMinBytes.store(minBytes);
		gSystemAllowed.store(allowed);
		gSystemRefused.store(0);
	}

	void checkSystemOutOfMemory(const CompressOutcome& outcome, const CompressRequest& request,
		const BudgetAllocator& allocator)
	{
		CHECK(gSystemRefused.load() > 0);
		REQUIRE(std::holds_alternative<CodecFailure>(outcome));
		const CodecFailure& failure = std::get<CodecFailure>(outcome);
		// Exit 70, not the budget refusal (4): the budget allowed the block, the system did not.
		CHECK(failure.code == ExitCode::internal);
		CHECK(toInt(failure.code) == 70);
		CHECK(failure.message.find("out of memory") != std::string::npos);
		CHECK_FALSE(fs::exists(request.output));
		CHECK(allocator.current() == 0);
		CHECK(allocator.lastFailure() == AllocationFailure::none);
	}
}

TEST_CASE("a malloc failure within the budget is exit 70 for both codecs, at context creation and after it")
{
	const TempDir dir;
	const Bytes data = stlLike(MiB, 31);
	writeBytes(dir.path() / "in.bin", data);
	const CompressRequest request = requestFor(dir, data.size(), 6144 * MiB);
	// allowed 0: the context itself cannot be created. allowed 1: the context exists, its
	// workspace (zstd) or first table (brotli) cannot be allocated.
	//
	// Not covered: zstd 1.5.7 crashes (SIGSEGV) when one of the small blocks of its multithreaded
	// setup (ZSTDMT_createCCtx_advanced, POOL_create) fails, because ZSTD_customCalloc writes to
	// the null pointer (fixed upstream after 1.5.7 in commit 3f8f9b3f, not released). So zstd with
	// workers is only failed at context creation here and at a worker's workspace below.
	struct ZstdCase
	{
		std::uint64_t allowed = 0;
		int workers = 0;
	};
	for (const ZstdCase zstdCase : {ZstdCase{0, 0}, ZstdCase{0, 4}, ZstdCase{1, 0}})
	{
		CAPTURE(zstdCase.allowed);
		CAPTURE(zstdCase.workers);
		resetExhaustibleMalloc(0, zstdCase.allowed);
		BudgetAllocator allocator{request.budgetBytes, &exhaustibleMalloc};
		std::ostringstream out;
		ProgressReporter progress{out, MiB};
		const CompressOutcome outcome = encodeZstd(planZstd(data.size(), 28), zstdCase.workers, request, progress, allocator);
		checkSystemOutOfMemory(outcome, request, allocator);
	}

	for (const std::uint64_t allowed : {std::uint64_t{0}, std::uint64_t{1}})
	{
		CAPTURE(allowed);
		resetExhaustibleMalloc(0, allowed);
		BudgetAllocator allocator{request.budgetBytes, &exhaustibleMalloc};
		std::ostringstream out;
		ProgressReporter progress{out, MiB};
		const CompressOutcome outcome = encodeBrotli(planBrotli(data.size(), 28), request, progress, allocator);
		checkSystemOutOfMemory(outcome, request, allocator);
	}
}

TEST_CASE("a malloc failure after output bytes were written: brotli exits 70 and removes the output")
{
	// As in the budget case above, but the budget stays at 6 GiB: from the first output byte on,
	// the system refuses every allocation, so the next metablock's allocation fails mid-stream.
	const TempDir dir;
	const Bytes data = stlLike(4 * MiB, 12);
	writeBytes(dir.path() / "in.bin", data);
	const CompressRequest request = requestFor(dir, data.size(), 6144 * MiB);
	resetExhaustibleMalloc(0, std::numeric_limits<std::uint64_t>::max());
	BudgetAllocator allocator{request.budgetBytes, &exhaustibleMalloc};
	std::uint64_t readWhenExhausted = 0;
	std::ostringstream out;
	ProgressReporter progress{out, MiB, [&](std::uint64_t read, std::uint64_t written)
	{
		if (written > 0 && readWhenExhausted == 0)
		{
			readWhenExhausted = read;
			CHECK(fs::exists(request.output));
			gSystemAllowed.store(0);
		}
	}};
	const CompressOutcome outcome = encodeBrotli(planBrotli(data.size(), 18), request, progress, allocator);
	CHECK(readWhenExhausted > 0);
	CHECK(readWhenExhausted < data.size() / 2);
	checkSystemOutOfMemory(outcome, request, allocator);
}

TEST_CASE("multithreaded zstd: a worker's malloc failing mid-run is exit 70, every worker stops, the output is removed")
{
	// The system hands out one worker context and refuses the second, on the second worker's
	// own thread; the budget (6 GiB) would allow both.
	const TempDir dir;
	const Bytes data = mixed8MiB();
	writeBytes(dir.path() / "in.bin", data);
	const ZstdPlan plan = planZstd(data.size(), 28);
	const CompressRequest request = requestFor(dir, data.size(), 6144 * MiB);
	REQUIRE(zstdEstimate(plan, 4) < request.budgetBytes);
	// Only a worker context's workspace is this large: the input ring buffer, the output buffers
	// and the LDM tables are each far smaller (checked by the estimate breakdown in the README).
	resetExhaustibleMalloc(plan.workerContextBytes / 2, 1);
	BudgetAllocator allocator{request.budgetBytes, &exhaustibleMalloc};
	std::ostringstream out;
	ProgressReporter progress{out, MiB};
	const CompressOutcome outcome = encodeZstd(plan, 4, request, progress, allocator);
	checkSystemOutOfMemory(outcome, request, allocator);
}

TEST_CASE("--threads 4 under a small budget: fewer workers, or single-threaded, never a refusal that a smaller count avoids")
{
	const Bytes data = mixed8MiB();
	const ZstdPlan plan = planZstd(data.size(), 28);
	const std::uint64_t allowance = BudgetAllocator::kHeaderAllowanceBytes;
	struct Case
	{
		std::uint64_t budgetMib;
		std::uint64_t workers;
	};
	const std::uint64_t twoWorkersMib = ceilMiB(zstdEstimate(plan, 2) + allowance);
	REQUIRE(twoWorkersMib * MiB < zstdEstimate(plan, 3) + allowance);
	const std::uint64_t singleMib = ceilMiB(plan.estimatedBytes + allowance);
	REQUIRE(singleMib * MiB < zstdEstimate(plan, 2) + allowance);
	for (const Case& entry : {Case{6144, 4}, Case{twoWorkersMib, 2}, Case{singleMib, 0}})
	{
		CAPTURE(entry.budgetMib);
		const TempDir dir;
		const AppRun run = compressFile(dir, "zstd", data,
			{"--threads", "4", "--memory-budget-mib", std::to_string(entry.budgetMib)});
		REQUIRE(run.code == ExitCode::ok);
		const std::optional<std::string> start = lineOfType(run.out, "start");
		REQUIRE(start.has_value());
		CHECK(numberField(*start, "threads") == 4);
		CHECK(numberField(*start, "workers") == entry.workers);
		const std::optional<std::string> result = lineOfType(run.out, "result");
		REQUIRE(result.has_value());
		CHECK(numberField(*result, "workers") == entry.workers);
		const std::optional<std::uint64_t> peak = numberField(*result, "peakBytes");
		REQUIRE(peak.has_value());
		CHECK(*peak <= entry.budgetMib * MiB);
		const std::optional<Bytes> decoded = decodeZstd(readBytes(dir.path() / "out.bin"), 28);
		REQUIRE(decoded.has_value());
		CHECK(*decoded == data);
	}
	// Below the single-threaded estimate it is still exit 4 before any output.
	const TempDir dir;
	const AppRun run = compressFile(dir, "zstd", data, {"--threads", "4", "--memory-budget-mib", "64"});
	CHECK(run.code == ExitCode::budget);
	CHECK_FALSE(fs::exists(dir.path() / "out.bin"));
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
