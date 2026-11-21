#include "projecto/cli.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <optional>
#include <system_error>
#include <utility>

namespace projecto
{
	namespace
	{
		enum class Flag : std::size_t
		{
			codec,
			root,
			input,
			output,
			inputSize,
			memoryBudget,
			maxWindowLog,
			progressInterval,
			watchStdin,
			threads,
			count,
		};

		struct FlagSpec
		{
			std::string_view name;
			Flag flag;
			bool required;
		};

		constexpr std::array<FlagSpec, static_cast<std::size_t>(Flag::count)> kFlags{{
			{"--codec", Flag::codec, true},
			{"--root", Flag::root, true},
			{"--input", Flag::input, true},
			{"--output", Flag::output, true},
			{"--input-size", Flag::inputSize, true},
			{"--memory-budget-mib", Flag::memoryBudget, false},
			{"--max-window-log", Flag::maxWindowLog, false},
			{"--progress-interval-mib", Flag::progressInterval, false},
			{"--watch-stdin", Flag::watchStdin, false},
			{"--threads", Flag::threads, false},
		}};

		using Seen = std::array<bool, static_cast<std::size_t>(Flag::count)>;

		UsageError usage(std::string message)
		{
			return UsageError{std::move(message)};
		}

		std::string describe(std::string_view flag, std::string_view text)
		{
			std::string message{flag};
			message += ": ";
			message += text;
			return message;
		}

		// The whole token must be decimal digits: no sign, no space, no suffix.
		std::optional<std::uint64_t> parseNumber(std::string_view token)
		{
			std::uint64_t value = 0;
			const char* const end = token.data() + token.size();
			const auto [ptr, ec] = std::from_chars(token.data(), end, value);
			if (token.empty() || ec != std::errc{} || ptr != end)
			{
				return std::nullopt;
			}
			return value;
		}

		std::variant<std::uint64_t, UsageError> parseRanged(
			std::string_view flag, std::string_view token, std::uint64_t min, std::uint64_t max)
		{
			const std::optional<std::uint64_t> value = parseNumber(token);
			if (!value)
			{
				return usage(describe(flag, "not a valid unsigned integer"));
			}
			if (*value < min || *value > max)
			{
				return usage(describe(flag, "must be between " + std::to_string(min) + " and " + std::to_string(max)));
			}
			return *value;
		}

		std::variant<std::filesystem::path, UsageError> parsePath(std::string_view flag, std::string_view token)
		{
			std::filesystem::path path{token};
			if (!path.is_absolute())
			{
				return usage(describe(flag, "must be an absolute path"));
			}
			return path;
		}

		std::optional<UsageError> take(std::variant<std::filesystem::path, UsageError>& parsed, std::filesystem::path& target)
		{
			if (UsageError* error = std::get_if<UsageError>(&parsed))
			{
				return std::move(*error);
			}
			target = std::move(std::get<std::filesystem::path>(parsed));
			return std::nullopt;
		}

		std::optional<UsageError> take(std::variant<std::uint64_t, UsageError>& parsed, std::uint64_t& target)
		{
			if (UsageError* error = std::get_if<UsageError>(&parsed))
			{
				return std::move(*error);
			}
			target = std::get<std::uint64_t>(parsed);
			return std::nullopt;
		}

		std::optional<UsageError> assign(Options& options, const FlagSpec& spec, std::string_view value)
		{
			switch (spec.flag)
			{
				case Flag::codec:
				{
					if (value == "zstd")
					{
						options.codec = Codec::zstd;
					}
					else if (value == "br")
					{
						options.codec = Codec::br;
					}
					else
					{
						return usage(describe(spec.name, "must be exactly zstd or br"));
					}
					return std::nullopt;
				}
				case Flag::root:
				{
					auto parsed = parsePath(spec.name, value);
					return take(parsed, options.root);
				}
				case Flag::input:
				{
					auto parsed = parsePath(spec.name, value);
					return take(parsed, options.input);
				}
				case Flag::output:
				{
					auto parsed = parsePath(spec.name, value);
					return take(parsed, options.output);
				}
				case Flag::inputSize:
				{
					auto parsed = parseRanged(spec.name, value, kMinInputSize, kMaxInputSize);
					return take(parsed, options.inputSize);
				}
				case Flag::memoryBudget:
				{
					auto parsed = parseRanged(spec.name, value, kMinMemoryBudgetMib, kMaxMemoryBudgetMib);
					return take(parsed, options.memoryBudgetMib);
				}
				case Flag::maxWindowLog:
				{
					auto parsed = parseRanged(spec.name, value, kMinWindowLog, kMaxWindowLog);
					return take(parsed, options.maxWindowLog);
				}
				case Flag::progressInterval:
				{
					auto parsed = parseRanged(spec.name, value, kMinProgressIntervalMib, kMaxProgressIntervalMib);
					return take(parsed, options.progressIntervalMib);
				}
				case Flag::watchStdin:
				{
					std::uint64_t enabled = 0;
					auto parsed = parseRanged(spec.name, value, 0, 1);
					if (std::optional<UsageError> error = take(parsed, enabled))
					{
						return error;
					}
					options.watchStdin = enabled == 1;
					return std::nullopt;
				}
				case Flag::threads:
				{
					auto parsed = parseRanged(spec.name, value, kMinThreads, kMaxThreads);
					return take(parsed, options.threads);
				}
				case Flag::count:
				{
					break;
				}
			}
			return usage("internal flag table error");
		}
	}

	ParseResult parseOptions(std::span<const std::string_view> args)
	{
		if (args.empty())
		{
			return usage("missing subcommand: expected --version or compress");
		}
		if (args.front() == "--version")
		{
			if (args.size() != 1)
			{
				return usage("--version takes no other arguments");
			}
			return VersionRequest{};
		}
		if (args.front() != "compress")
		{
			return usage("unknown subcommand: expected --version or compress");
		}

		Options options;
		Seen seen{};
		const std::span<const std::string_view> tokens = args.subspan(1);
		for (std::size_t i = 0; i < tokens.size(); i += 2)
		{
			const auto spec = std::ranges::find(kFlags, tokens[i], &FlagSpec::name);
			if (spec == kFlags.end())
			{
				return usage("unknown argument: " + std::string{tokens[i]});
			}
			const std::size_t index = static_cast<std::size_t>(spec->flag);
			if (seen[index])
			{
				return usage(describe(spec->name, "given more than once"));
			}
			if (i + 1 >= tokens.size())
			{
				return usage(describe(spec->name, "missing value"));
			}
			seen[index] = true;
			if (std::optional<UsageError> error = assign(options, *spec, tokens[i + 1]))
			{
				return std::move(*error);
			}
		}

		const auto missing = std::ranges::find_if(kFlags, [&seen](const FlagSpec& spec)
		{
			return spec.required && !seen[static_cast<std::size_t>(spec.flag)];
		});
		if (missing != kFlags.end())
		{
			return usage(describe(missing->name, "required flag is missing"));
		}
		return options;
	}

	std::string_view codecName(Codec codec) noexcept
	{
		return codec == Codec::br ? "br" : "zstd";
	}
}
