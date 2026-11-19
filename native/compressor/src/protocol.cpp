#include "projecto/protocol.hpp"

#include <ostream>
#include <stdexcept>

namespace projecto
{
	namespace
	{
		constexpr std::string_view kHexDigits = "0123456789abcdef";
		constexpr std::string_view kReplacement = "\\ufffd";

		bool isContinuation(unsigned char byte) noexcept
		{
			return (byte & 0xC0U) == 0x80U;
		}

		// Length of the well-formed UTF-8 sequence at the start of text (1 to 4), or 0 when
		// the first byte does not start one. Rejects overlong forms, surrogates and values above U+10FFFF.
		std::size_t utf8Length(std::string_view text) noexcept
		{
			const auto at = [&text](std::size_t index) noexcept
			{
				return index < text.size() ? static_cast<unsigned char>(text[index]) : static_cast<unsigned char>(0);
			};
			const unsigned char lead = at(0);
			if (lead < 0x80U)
			{
				return 1;
			}
			if (lead >= 0xC2U && lead <= 0xDFU)
			{
				return isContinuation(at(1)) ? 2 : 0;
			}
			if (lead >= 0xE0U && lead <= 0xEFU)
			{
				const unsigned char second = at(1);
				unsigned char low = 0x80U;
				unsigned char high = 0xBFU;
				if (lead == 0xE0U)
				{
					low = 0xA0U;
				}
				else if (lead == 0xEDU)
				{
					high = 0x9FU;
				}
				return second >= low && second <= high && isContinuation(at(2)) ? 3 : 0;
			}
			if (lead >= 0xF0U && lead <= 0xF4U)
			{
				const unsigned char second = at(1);
				unsigned char low = 0x80U;
				unsigned char high = 0xBFU;
				if (lead == 0xF0U)
				{
					low = 0x90U;
				}
				else if (lead == 0xF4U)
				{
					high = 0x8FU;
				}
				return second >= low && second <= high && isContinuation(at(2)) && isContinuation(at(3)) ? 4 : 0;
			}
			return 0;
		}

		std::string escapeAscii(char ch)
		{
			switch (ch)
			{
				case '"':
					return "\\\"";
				case '\\':
					return "\\\\";
				case '\n':
					return "\\n";
				case '\r':
					return "\\r";
				case '\t':
					return "\\t";
				case '\b':
					return "\\b";
				case '\f':
					return "\\f";
				default:
					break;
			}
			const auto value = static_cast<unsigned char>(ch);
			if (value < 0x20U)
			{
				std::string escaped = "\\u00";
				escaped += kHexDigits[value >> 4U];
				escaped += kHexDigits[value & 0x0FU];
				return escaped;
			}
			return std::string(1, ch);
		}
	}

	std::string escapeJson(std::string_view text, std::size_t maxEscapedBytes)
	{
		std::string out;
		out.reserve(text.size() < maxEscapedBytes ? text.size() : maxEscapedBytes);
		while (!text.empty())
		{
			const std::size_t length = utf8Length(text);
			std::string piece;
			std::size_t consumed = 1;
			if (length == 0)
			{
				piece = kReplacement;
			}
			else if (length == 1)
			{
				piece = escapeAscii(text.front());
			}
			else
			{
				piece = std::string{text.substr(0, length)};
				consumed = length;
			}
			if (out.size() + piece.size() > maxEscapedBytes)
			{
				break;
			}
			out += piece;
			text.remove_prefix(consumed);
		}
		return out;
	}

	JsonLine::JsonLine(std::string_view type)
		: body_("{")
	{
		key("type");
		body_ += '"';
		body_ += escapeJson(type);
		body_ += '"';
	}

	void JsonLine::key(std::string_view name)
	{
		if (body_.size() > 1)
		{
			body_ += ',';
		}
		body_ += '"';
		body_ += escapeJson(name);
		body_ += "\":";
	}

	JsonLine& JsonLine::text(std::string_view name, std::string_view value)
	{
		key(name);
		body_ += '"';
		body_ += escapeJson(value);
		body_ += '"';
		return *this;
	}

	JsonLine& JsonLine::number(std::string_view name, std::uint64_t value)
	{
		key(name);
		body_ += std::to_string(value);
		return *this;
	}

	JsonLine& JsonLine::boolean(std::string_view name, bool value)
	{
		key(name);
		body_ += value ? "true" : "false";
		return *this;
	}

	JsonLine& JsonLine::null(std::string_view name)
	{
		key(name);
		body_ += "null";
		return *this;
	}

	std::string JsonLine::str() const
	{
		std::string line = body_;
		line += "}\n";
		if (line.size() > kMaxLineBytes)
		{
			throw std::length_error("JSON line exceeds 4 KiB");
		}
		return line;
	}

	JsonLine errorResult(ExitCode code, std::string_view message)
	{
		JsonLine line{"result"};
		line.boolean("ok", false).text("error", errorName(code)).text("message", message);
		return line;
	}

	bool writeLine(std::ostream& out, const JsonLine& line)
	{
		out << line.str() << std::flush;
		return out.good();
	}
}
