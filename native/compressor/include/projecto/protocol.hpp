#pragma once

#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <string>
#include <string_view>

#include "projecto/exit_code.hpp"

namespace projecto
{
	// stdout lines are at most 4 KiB including the newline (phase4.md section 7.2).
	inline constexpr std::size_t kMaxLineBytes = 4096;
	// Longest escaped text value; longer values are cut at a character boundary.
	inline constexpr std::size_t kMaxTextBytes = 1536;

	// Escapes a string for use between JSON quotes. Valid UTF-8 passes through,
	// invalid bytes become U+FFFD, control characters become escapes. Output
	// stops before exceeding maxEscapedBytes, never inside a character.
	std::string escapeJson(std::string_view text, std::size_t maxEscapedBytes = kMaxTextBytes);

	// One flat JSON object on one line: {"type":"...", ...}. Only numbers, booleans,
	// null and escaped strings can be added. Keys are written by the caller as fixed
	// ASCII names (they are escaped as well).
	class JsonLine
	{
	public:
		explicit JsonLine(std::string_view type);

		JsonLine& text(std::string_view key, std::string_view value);
		JsonLine& number(std::string_view key, std::uint64_t value);
		JsonLine& boolean(std::string_view key, bool value);
		JsonLine& null(std::string_view key);

		// The finished line with a trailing newline. Throws std::length_error
		// when it would exceed kMaxLineBytes.
		std::string str() const;

	private:
		void key(std::string_view name);

		std::string body_;
	};

	// {"type":"result","ok":false,"error":"<errorName>","message":"..."}
	JsonLine errorResult(ExitCode code, std::string_view message);

	// Writes the line and flushes, so a reader sees it immediately.
	// Returns false when the stream is not good afterwards (for example a closed pipe).
	[[nodiscard]] bool writeLine(std::ostream& out, const JsonLine& line);
}
