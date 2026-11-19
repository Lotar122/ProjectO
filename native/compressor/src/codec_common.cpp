#include "projecto/codec_common.hpp"

#include <algorithm>
#include <format>
#include <system_error>
#include <ostream>
#include <utility>

#include "projecto/protocol.hpp"

namespace projecto
{
	namespace fs = std::filesystem;

	std::string formatBytes(std::uint64_t bytes)
	{
		const double mib = static_cast<double>(bytes) / static_cast<double>(kMiB);
		if (mib >= 1024.0)
		{
			return std::format("{:.1f} GiB", mib / 1024.0);
		}
		return std::format("{:.1f} MiB", mib);
	}

	ProgressReporter::ProgressReporter(std::ostream& out, std::uint64_t intervalBytes, Listener listener)
		: out_(out)
		, interval_(intervalBytes == 0 ? kMiB : intervalBytes)
		, next_(interval_)
		, listener_(std::move(listener))
	{
	}

	std::optional<CodecFailure> ProgressReporter::update(std::uint64_t bytesRead, std::uint64_t bytesWritten)
	{
		if (listener_)
		{
			listener_(bytesRead, bytesWritten);
		}
		if (bytesRead < next_)
		{
			return std::nullopt;
		}
		next_ = (bytesRead / interval_ + 1) * interval_;
		JsonLine line{"progress"};
		line.number("read", bytesRead).number("written", bytesWritten);
		if (!writeLine(out_, line))
		{
			return CodecFailure{ExitCode::io, "cannot write a progress line to stdout"};
		}
		return std::nullopt;
	}

	InputReader::InputReader(File file, std::uint64_t expectedSize)
		: file_(std::move(file))
		, buffer_(makeIoBuffer())
		, expected_(expectedSize)
	{
	}

	std::variant<InputReader, CodecFailure> InputReader::open(const fs::path& path, std::uint64_t expectedSize)
	{
		auto opened = File::openRead(path);
		if (IoError* error = std::get_if<IoError>(&opened))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		File& file = std::get<File>(opened);

		// The path was validated before the open; check it again now that the handle exists,
		// and measure the size on the handle itself. Portable C++ cannot tie the open handle
		// to the inode that was validated, so file identity stays unbound: a swap between the
		// validation and this check is caught, a swap back after it is not. The root is a
		// private temp directory, which is what keeps that window closed in practice.
		std::error_code ec;
		const fs::file_status status = fs::symlink_status(path, ec);
		if (ec || status.type() != fs::file_type::regular)
		{
			return CodecFailure{ExitCode::io, "input is no longer a regular file: " + path.string()};
		}
		auto measured = file.size();
		if (IoError* error = std::get_if<IoError>(&measured))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		const std::uint64_t actual = std::get<std::uint64_t>(measured);
		if (actual != expectedSize)
		{
			return CodecFailure{ExitCode::io, std::format("input size changed to {} bytes, expected {}", actual, expectedSize)};
		}
		return InputReader{std::move(file), expectedSize};
	}

	std::variant<std::span<const std::byte>, CodecFailure> InputReader::next()
	{
		// Read exactly the expected bytes; after that, one probe byte must find the end of file.
		const std::uint64_t remaining = expected_ - read_;
		const bool probing = remaining == 0;
		const std::size_t want = probing ? 1 : static_cast<std::size_t>(std::min<std::uint64_t>(remaining, buffer_.size()));
		auto result = file_.read(std::span<std::byte>{buffer_}.first(want));
		if (IoError* error = std::get_if<IoError>(&result))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		const std::size_t count = std::get<std::size_t>(result);
		if (probing)
		{
			if (count != 0)
			{
				return CodecFailure{ExitCode::io, std::format("input is longer than the expected {} bytes", expected_)};
			}
			return std::span<const std::byte>{};
		}
		if (count == 0)
		{
			return CodecFailure{ExitCode::io, std::format("input ended after {} bytes, expected {}", read_, expected_)};
		}
		read_ += count;
		return std::span<const std::byte>{buffer_.data(), count};
	}

	OutputFile::OutputFile(File file, fs::path path)
		: file_(std::move(file))
		, path_(std::move(path))
	{
	}

	OutputFile::OutputFile(OutputFile&& other) noexcept
		: file_(std::move(other.file_))
		, path_(std::move(other.path_))
		, written_(other.written_)
		, owned_(std::exchange(other.owned_, false))
	{
	}

	OutputFile::~OutputFile()
	{
		if (owned_ && file_.createdByThisProcess())
		{
			file_.close();
			removeQuietly(path_);
		}
	}

	std::variant<OutputFile, CodecFailure> OutputFile::create(const fs::path& path)
	{
		auto created = File::createExclusive(path);
		if (IoError* error = std::get_if<IoError>(&created))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		return OutputFile{std::move(std::get<File>(created)), path};
	}

	std::optional<CodecFailure> OutputFile::write(std::span<const std::byte> data)
	{
		if (data.empty())
		{
			return std::nullopt;
		}
		if (std::optional<IoError> error = file_.write(data))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		written_ += data.size();
		return std::nullopt;
	}

	std::optional<CodecFailure> OutputFile::commit()
	{
		if (std::optional<IoError> error = file_.close())
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		owned_ = false;
		return std::nullopt;
	}
}
