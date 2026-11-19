#include "projecto/file_io.hpp"

#include <cerrno>
#include <system_error>
#include <utility>

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

		// The C stdio API takes narrow paths. Paths handed to this binary are generated ASCII
		// names (UUIDs in a temp directory), so no wide-character open is needed.
		std::variant<std::FILE*, IoError> openWith(const fs::path& path, const char* mode, std::string_view what)
		{
			errno = 0;
			std::FILE* file = std::fopen(path.string().c_str(), mode);
			if (file == nullptr)
			{
				return IoError{describe(what, path, errno)};
			}
			return file;
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

	std::variant<File, IoError> File::openRead(const fs::path& path)
	{
		auto opened = openWith(path, "rb", "cannot open for reading");
		if (IoError* error = std::get_if<IoError>(&opened))
		{
			return std::move(*error);
		}
		return File{std::get<std::FILE*>(opened), path, false};
	}

	std::variant<File, IoError> File::createExclusive(const fs::path& path)
	{
		auto opened = openWith(path, "wbx", "cannot create");
		if (IoError* error = std::get_if<IoError>(&opened))
		{
			return std::move(*error);
		}
		return File{std::get<std::FILE*>(opened), path, true};
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

	std::variant<std::uint64_t, IoError> File::size()
	{
		if (!file_)
		{
			return IoError{describe("size of closed file", path_, 0)};
		}
		errno = 0;
		if (std::fseek(file_.get(), 0, SEEK_END) != 0)
		{
			return IoError{describe("cannot seek to the end of", path_, errno)};
		}
		errno = 0;
		const long end = std::ftell(file_.get());
		if (end < 0)
		{
			return IoError{describe("cannot measure", path_, errno)};
		}
		errno = 0;
		if (std::fseek(file_.get(), 0, SEEK_SET) != 0)
		{
			return IoError{describe("cannot seek back to the start of", path_, errno)};
		}
		return static_cast<std::uint64_t>(end);
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
