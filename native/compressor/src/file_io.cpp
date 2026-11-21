#include "projecto/file_io.hpp"

#include <cerrno>
#include <string_view>
#include <system_error>
#include <utility>

#include "projecto/platform.hpp"

namespace projecto
{
	namespace fs = std::filesystem;

	namespace
	{
		std::string describe(std::string_view what, const fs::path& path, int error)
		{
			std::string message{what};
			message += " ";
			message += path.string();
			if (error != 0)
			{
				message += ": ";
				message += std::generic_category().message(error);
			}
			return message;
		}

		// Paths handed to this binary are generated ASCII names (UUIDs in a temp directory),
		// so the narrow-path opens in platform.cpp are enough.
		std::variant<std::FILE*, IoError> opened(std::variant<std::FILE*, platform::ErrorNumber> result, const fs::path& path,
			std::string_view what)
		{
			if (const platform::ErrorNumber* error = std::get_if<platform::ErrorNumber>(&result))
			{
				return IoError{describe(what, path, *error)};
			}
			return std::get<std::FILE*>(result);
		}
	}

	Buffer makeIoBuffer()
	{
		return Buffer(kIoBufferBytes);
	}

	void File::Closer::operator()(std::FILE* file) const noexcept
	{
		std::fclose(file);
	}

	File::File(std::FILE* file, fs::path path, bool created)
		: file_(file)
		, path_(std::move(path))
		, created_(created)
	{
	}

	// The path is copied before the open: once the handle exists nothing may throw, or the
	// FILE* would leak (and a created file stay behind).
	std::variant<File, IoError> File::openRead(const fs::path& path)
	{
		fs::path ownedPath = path;
		auto result = opened(platform::openForReading(ownedPath), ownedPath, "cannot open for reading");
		if (IoError* error = std::get_if<IoError>(&result))
		{
			return std::move(*error);
		}
		return File{std::get<std::FILE*>(result), std::move(ownedPath), false};
	}

	std::variant<File, IoError> File::createExclusive(const fs::path& path)
	{
		fs::path ownedPath = path;
		auto result = opened(platform::createNew(ownedPath), ownedPath, "cannot create");
		if (IoError* error = std::get_if<IoError>(&result))
		{
			return std::move(*error);
		}
		return File{std::get<std::FILE*>(result), std::move(ownedPath), true};
	}

	std::variant<std::size_t, IoError> File::read(std::span<std::byte> buffer)
	{
		if (!file_)
		{
			return IoError{describe("read from closed file", path_, 0)};
		}
		if (buffer.empty())
		{
			return std::size_t{0};
		}
		errno = 0;
		const std::size_t count = std::fread(buffer.data(), 1, buffer.size(), file_.get());
		if (count < buffer.size() && std::ferror(file_.get()) != 0)
		{
			return IoError{describe("read failed on", path_, errno)};
		}
		return count;
	}

	std::optional<IoError> File::write(std::span<const std::byte> data)
	{
		if (!file_)
		{
			return IoError{describe("write to closed file", path_, 0)};
		}
		if (data.empty())
		{
			return std::nullopt;
		}
		errno = 0;
		if (std::fwrite(data.data(), 1, data.size(), file_.get()) != data.size())
		{
			return IoError{describe("write failed on", path_, errno)};
		}
		return std::nullopt;
	}

	std::variant<FileFacts, IoError> File::inspect() const
	{
		if (!file_)
		{
			return IoError{describe("inspect closed file", path_, 0)};
		}
		auto facts = platform::inspect(file_.get());
		if (const platform::ErrorNumber* error = std::get_if<platform::ErrorNumber>(&facts))
		{
			return IoError{describe("cannot inspect", path_, *error)};
		}
		return std::get<FileFacts>(facts);
	}

	std::variant<std::uint64_t, IoError> File::size() const
	{
		auto facts = inspect();
		if (IoError* error = std::get_if<IoError>(&facts))
		{
			return std::move(*error);
		}
		return std::get<FileFacts>(facts).size;
	}

	std::optional<IoError> File::sync()
	{
		if (!file_)
		{
			return IoError{describe("sync of closed file", path_, 0)};
		}
		if (const platform::ErrorNumber error = platform::syncToStorage(file_.get()); error != 0)
		{
			return IoError{describe("cannot sync", path_, error)};
		}
		return std::nullopt;
	}

	std::optional<IoError> File::close()
	{
		std::FILE* file = file_.release();
		if (file == nullptr)
		{
			return std::nullopt;
		}
		errno = 0;
		if (std::fclose(file) != 0)
		{
			return IoError{describe("close failed on", path_, errno)};
		}
		return std::nullopt;
	}

	void removeQuietly(const fs::path& path) noexcept
	{
		std::error_code ec;
		fs::remove(path, ec);
	}
}
