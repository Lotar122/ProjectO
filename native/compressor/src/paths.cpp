#include "projecto/paths.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

namespace projecto
{
	namespace fs = std::filesystem;

	namespace
	{
		PathError rule(std::string message)
		{
			return PathError{ExitCode::usage, std::move(message)};
		}

		PathError ioFailure(std::string_view what, const std::filesystem::path& path, const std::error_code& ec)
		{
			std::string message{what};
			message += " ";
			message += path.string();
			message += ": ";
			message += ec.message();
			return PathError{ExitCode::io, std::move(message)};
		}

		bool hasUsableFilename(const fs::path& path)
		{
			if (!path.has_filename())
			{
				return false;
			}
			const fs::path name = path.filename();
			return name != "." && name != "..";
		}

		// The canonical parent directory must be the canonical root: the file is a direct child.
		std::optional<PathError> checkDirectChild(const fs::path& canonicalRoot, const fs::path& path, std::string_view label)
		{
			if (!hasUsableFilename(path))
			{
				return rule(std::string{label} + " has no file name");
			}
			std::error_code ec;
			const fs::path parent = fs::canonical(path.parent_path(), ec);
			if (ec == std::errc::no_such_file_or_directory || ec == std::errc::not_a_directory)
			{
				return rule(std::string{label} + " directory does not exist: " + path.parent_path().string());
			}
			if (ec)
			{
				return ioFailure("cannot resolve the directory of", path, ec);
			}
			const bool same = fs::equivalent(parent, canonicalRoot, ec);
			if (ec)
			{
				return ioFailure("cannot compare directories for", path, ec);
			}
			if (!same)
			{
				return rule(std::string{label} + " must be a direct child of the root directory");
			}
			return std::nullopt;
		}
	}

	std::variant<fs::path, PathError> validateRoot(const fs::path& root)
	{
		if (!root.is_absolute())
		{
			return rule("root must be an absolute path");
		}
		// A trailing separator would make the OS follow a symlink; look at the last component itself.
		// Only trailing separators are stripped: ".." is left for fs::canonical, because resolving it
		// lexically would be wrong when the component before it is a symlink.
		fs::path target = root;
		while (!target.has_filename() && target.has_relative_path())
		{
			target = target.parent_path();
		}

		std::error_code ec;
		const fs::file_status status = fs::symlink_status(target, ec);
		if (status.type() == fs::file_type::not_found)
		{
			return rule("root does not exist: " + root.string());
		}
		if (ec)
		{
			return ioFailure("cannot inspect root", root, ec);
		}
		if (status.type() == fs::file_type::symlink)
		{
			return rule("root must not be a symlink");
		}
		if (status.type() != fs::file_type::directory)
		{
			return rule("root must be a directory");
		}

		fs::path canonical = fs::canonical(target, ec);
		if (ec)
		{
			return ioFailure("cannot canonicalise root", root, ec);
		}
		return canonical;
	}

	std::variant<fs::path, PathError> validateInput(
		const fs::path& canonicalRoot, const fs::path& input, std::uint64_t expectedSize)
	{
		if (!input.is_absolute())
		{
			return rule("input must be an absolute path");
		}
		if (!hasUsableFilename(input))
		{
			return rule("input has no file name");
		}

		std::error_code ec;
		const fs::file_status status = fs::symlink_status(input, ec);
		if (status.type() == fs::file_type::not_found)
		{
			return rule("input does not exist: " + input.string());
		}
		if (ec)
		{
			return ioFailure("cannot inspect input", input, ec);
		}
		if (status.type() == fs::file_type::symlink)
		{
			return rule("input must not be a symlink");
		}
		if (status.type() != fs::file_type::regular)
		{
			return rule("input must be a regular file");
		}

		if (std::optional<PathError> error = checkDirectChild(canonicalRoot, input, "input"))
		{
			return std::move(*error);
		}

		const std::uintmax_t actualSize = fs::file_size(input, ec);
		if (ec)
		{
			return ioFailure("cannot read size of", input, ec);
		}
		if (actualSize != expectedSize)
		{
			return rule("input size is " + std::to_string(actualSize) + " but --input-size is " + std::to_string(expectedSize));
		}
		return canonicalRoot / input.filename();
	}

	std::variant<fs::path, PathError> validateOutput(
		const fs::path& canonicalRoot, const fs::path& input, const fs::path& output)
	{
		if (!output.is_absolute())
		{
			return rule("output must be an absolute path");
		}
		if (!hasUsableFilename(output))
		{
			return rule("output has no file name");
		}
		if (output.filename() == input.filename())
		{
			return rule("output must have a different file name than the input");
		}
		if (std::optional<PathError> error = checkDirectChild(canonicalRoot, output, "output"))
		{
			return std::move(*error);
		}

		std::error_code ec;
		const fs::file_status status = fs::symlink_status(output, ec);
		if (status.type() != fs::file_type::not_found)
		{
			if (ec)
			{
				return ioFailure("cannot inspect output", output, ec);
			}
			return rule("output already exists: " + output.string());
		}
		return canonicalRoot / output.filename();
	}

	std::variant<ValidatedPaths, PathError> validatePaths(const Options& options)
	{
		auto root = validateRoot(options.root);
		if (PathError* error = std::get_if<PathError>(&root))
		{
			return std::move(*error);
		}
		ValidatedPaths paths;
		paths.root = std::move(std::get<fs::path>(root));

		auto input = validateInput(paths.root, options.input, options.inputSize);
		if (PathError* error = std::get_if<PathError>(&input))
		{
			return std::move(*error);
		}
		paths.input = std::move(std::get<fs::path>(input));

		auto output = validateOutput(paths.root, paths.input, options.output);
		if (PathError* error = std::get_if<PathError>(&output))
		{
			return std::move(*error);
		}
		paths.output = std::move(std::get<fs::path>(output));
		return paths;
	}
}
