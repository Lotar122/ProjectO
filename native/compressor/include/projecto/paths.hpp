#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <variant>

#include "projecto/cli.hpp"
#include "projecto/exit_code.hpp"

namespace projecto
{
	struct PathError
	{
		ExitCode code = ExitCode::usage;
		std::string message;
	};

	// Canonical paths to use from here on. input and output are root / filename,
	// so later opens do not depend on how the caller spelled the paths.
	struct ValidatedPaths
	{
		std::filesystem::path root;
		std::filesystem::path input;
		std::filesystem::path output;
	};

	// Rules of phase4.md section 7.1. Rule violations are ExitCode::usage,
	// unexpected file system errors are ExitCode::io.

	// Absolute, exists, is a directory and is not a symlink. Returns the canonical root.
	std::variant<std::filesystem::path, PathError> validateRoot(const std::filesystem::path& root);

	// Absolute, a regular file (no symlink), a direct child of canonicalRoot, file_size == expectedSize.
	// Returns canonicalRoot / filename.
	std::variant<std::filesystem::path, PathError> validateInput(
		const std::filesystem::path& canonicalRoot, const std::filesystem::path& input, std::uint64_t expectedSize);

	// Absolute, a direct child of canonicalRoot, a different filename than the input, does not exist
	// (a dangling symlink counts as existing). Returns canonicalRoot / filename.
	std::variant<std::filesystem::path, PathError> validateOutput(
		const std::filesystem::path& canonicalRoot, const std::filesystem::path& input, const std::filesystem::path& output);

	std::variant<ValidatedPaths, PathError> validatePaths(const Options& options);
}
