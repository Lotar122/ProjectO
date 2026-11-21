#include "projecto/codec_common.hpp"

#include <algorithm>
#include <format>
#include <system_error>
#include <ostream>
#include <utility>

#include "projecto/pending_outputs.hpp"
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

		// The path was validated before the open, so the rules are checked again on what the
		// handle actually refers to: whatever was swapped in between, the bytes compressed are
		// those of a regular file with a single link and the expected size. On POSIX the open
		// refused a symlink (O_NOFOLLOW) and could not hang on a FIFO (O_NONBLOCK). The path
		// check below covers platforms without O_NOFOLLOW.
		std::error_code ec;
		const fs::file_status status = fs::symlink_status(path, ec);
		if (ec || status.type() != fs::file_type::regular)
		{
			return CodecFailure{ExitCode::io, "input is no longer a regular file: " + path.string()};
		}
		auto inspected = file.inspect();
		if (IoError* error = std::get_if<IoError>(&inspected))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		const FileFacts& facts = std::get<FileFacts>(inspected);
		if (!facts.regular)
		{
			return CodecFailure{ExitCode::io, "input is no longer a regular file: " + path.string()};
		}
		if (facts.links != 1)
		{
			return CodecFailure{ExitCode::io, std::format("input has {} hard links, expected 1: {}", facts.links, path.string())};
		}
		if (facts.size != expectedSize)
		{
			return CodecFailure{ExitCode::io, std::format("input size changed to {} bytes, expected {}", facts.size, expectedSize)};
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
		if (!owned_ || !file_.createdByThisProcess())
		{
			return;
		}
		// A close error does not matter for a file that is removed next. It is closed first
		// because Windows cannot remove an open file.
		try
		{
			PendingOutputs& pending = PendingOutputs::instance();
			const auto held = pending.lock();
			static_cast<void>(file_.close());
			removeQuietly(path_);
			pending.erase(held, path_);
		}
		catch (...)
		{
			// The lock could not be taken, or the close error could not be described (out of
			// memory). The file is still removed; the registry keeps the stale path, which only
			// a shutdown would act on, by removing an already missing file.
			try
			{
				static_cast<void>(file_.close());
			}
			catch (...)
			{
			}
			removeQuietly(path_);
		}
	}

	std::variant<OutputFile, CodecFailure> OutputFile::create(const fs::path& path)
	{
		// Copied before the file exists, so nothing between the create and the return can
		// throw except add(), which cleans up after itself.
		fs::path ownedPath = path;
		// Created and registered under one lock, so a shutdown on another thread either runs
		// before the file exists or finds it registered and removes it.
		PendingOutputs& pending = PendingOutputs::instance();
		const auto held = pending.lock();
		auto created = File::createExclusive(ownedPath);
		if (IoError* error = std::get_if<IoError>(&created))
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		File& file = std::get<File>(created);
		try
		{
			pending.add(held, ownedPath);
		}
		catch (...)
		{
			// Closed first because Windows cannot remove an open file; a close error does not
			// matter for a file that is removed next.
			try
			{
				static_cast<void>(file.close());
			}
			catch (...)
			{
			}
			removeQuietly(ownedPath);
			throw;
		}
		return OutputFile{std::move(file), std::move(ownedPath)};
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
		// On stable storage before it counts as committed: a crash after the result line
		// must not leave a short or empty file behind a successful result.
		if (std::optional<IoError> error = file_.sync())
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		if (std::optional<IoError> error = file_.close())
		{
			return CodecFailure{ExitCode::io, std::move(error->message)};
		}
		// Unregistered and the run marked finished in one hold: a closed stdin either removes
		// the file before this (no result was reported yet) or finds the run finished.
		PendingOutputs& pending = PendingOutputs::instance();
		const auto held = pending.lock();
		pending.eraseCommitted(held, path_);
		owned_ = false;
		return std::nullopt;
	}
}
