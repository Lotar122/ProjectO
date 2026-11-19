# projecto-compress

Command-line compressor for the order archiver (zstd and brotli, statically linked).
The contract is in `phases-bugfix/phase4.md` sections 7 and 8, amended by `phases-bugfix/phase4-amendments.md`.

Status: W17 (CLI, paths, protocol) and W18 (zstd and brotli codecs, memory budget, counting allocator).

## Usage

```
projecto-compress --version
projecto-compress compress --codec zstd|br --root <abs dir> --input <abs file> --output <abs file>
                  --input-size <bytes> [--memory-budget-mib <n>] [--max-window-log <n>]
                  [--progress-interval-mib <n>]
```

| Flag | Rule |
|---|---|
| `--codec` | exactly `zstd` or `br` |
| `--root` | absolute, exists, a directory, not a symlink |
| `--input` | absolute, a regular file (no symlink), a direct child of the root, size equals `--input-size` |
| `--output` | absolute, a direct child of the root, a different file name than the input, must not exist (created with `"wbx"`) |
| `--input-size` | whole decimal number, 1 to 2^30 |
| `--memory-budget-mib` | 64 to 7168, default 6144 |
| `--max-window-log` | 10 to 28, default 28 |
| `--progress-interval-mib` | 1 to 1024, default 64 |

Each flag takes its value as the next token (`--flag value`, not `--flag=value`) and may appear once.
An unknown, duplicate or missing flag is a usage error. The binary reads no environment variables.

stdout carries JSON lines (at most 4 KiB each); stderr carries human-readable text.

| Exit code | Meaning |
|---|---|
| 0 | success |
| 2 | usage or validation |
| 3 | I/O |
| 4 | memory budget |
| 5 | codec error |
| 70 | internal |

```
$ projecto-compress --version
{"type":"version","version":"1.0.0","zstd":"1.5.7","brotli":"1.2.1"}
```

A `compress` run prints one `start` line, a `progress` line each time another `--progress-interval-mib` of input
has been read, and one `result` line:

```
{"type":"start","codec":"zstd","level":22,"windowLog":28,"chainLog":29,"hashLog":25,"searchLog":9,"minMatch":3,"targetLength":999,"strategy":9,"ldm":true,"ldmHashLog":24,"ldmMinMatch":32,"ldmBucketSizeLog":8,"ldmHashRateLog":4,"estimatedBytes":2686042775,"budgetBytes":6442450944}
{"type":"progress","read":67108864,"written":8306792}
{"type":"result","ok":true,"codec":"zstd","inputSize":67108864,"outputSize":8306799,"peakBytes":773391031,"elapsedMs":107183,"encoder":"projecto-compress/1.0.0 zstd/1.5.7"}
{"type":"start","codec":"br","quality":11,"lgwin":23,"largeWindow":false,"estimatedBytes":329517559,"budgetBytes":67108864}
{"type":"result","ok":false,"error":"memory_budget","message":"brotli q11 lgwin 23 needs 314.3 MiB > budget 64.0 MiB"}
```

## Parameters and memory

The parameters depend on the input size alone (`phase4-amendments.md` A2 to A4). The budget never lowers them.

- zstd: level 22, `windowLog = clamp(ceil(log2(size)), 10, --max-window-log)`, `chainLog = windowLog + 1`, every other
  value at the level-22 default, LDM on with its four parameters set explicitly, checksum and content size on.
- brotli: quality 11, `lgwin` as above, generic mode, size hint `min(size, 2^30)`. Above `lgwin` 24 the stream uses
  the large-window format (`BROTLI_PARAM_LARGE_WINDOW`); streams up to 16 MiB stay standard RFC 7932.
- The estimate (`ZSTD_estimateCStreamSize_usingCCtxParams`, `BrotliEncoderEstimatePeakMemoryUsage`) is checked against
  `--memory-budget-mib` before the output is created, with room for the allocator's block headers (16 bytes for each of
  up to 4096 live blocks; zstd keeps 2 live, brotli about 25 at 64 MiB); over budget is exit 4.
- A counting allocator backs both libraries and refuses any allocation above the budget (also exit 4). `peakBytes` is
  its high-water mark, block headers included. brotlienc is built with `BROTLI_ENCODER_CLEANUP_ON_OOM`, because its
  default reaction to a failed allocation is `exit(1)`.
- The estimates are those of the pinned single-threaded zstd build: one pointer (8 bytes) below the table in
  `phase4-amendments.md` A6, which was measured with a multithreaded system libzstd.

## Files

- The output is created with `fopen(..., "wbx")`, so its mode is `0666 & ~umask`. Run the binary with the umask the
  output should have.
- On every failure the binary removes the output it created. It never removes a file it did not create.
- SIGPIPE is ignored (where the platform has it), so a reader that goes away makes the next stdout write fail:
  exit 3 and the output is removed, instead of a signal death that would leave it behind.
- `tests/posix_failure_tests.sh` (registered with ctest on POSIX systems) covers a closed stdout pipe and an output
  over the file size limit, for both codecs.
- The input is checked again after it is opened (still a regular file, not a symlink, and the size measured on the
  open handle equals `--input-size`). Exactly that many bytes are compressed, then end of file is required; anything
  else is exit 3. Portable C++ cannot bind the open handle to the inode that was validated, so file identity is not
  bound: a swap between validation and open is caught only if it changes the type or size. The root is a private temp
  directory, which is what closes that window in practice.

## Build

Requires CMake 3.24 or newer, a C++20 compiler (GCC or Clang on Linux, MSVC on Windows) and network access for the first configure
(zstd, brotli and doctest are fetched by URL and checked against a pinned SHA256 in `cmake/Dependencies.cmake`).

Linux:

```
cmake -S native/compressor -B build/compressor -G Ninja
cmake --build build/compressor
ctest --test-dir build/compressor --output-on-failure
```

Pick a compiler with `-DCMAKE_CXX_COMPILER=g++` or `clang++` (and the matching `-DCMAKE_C_COMPILER=gcc` or `clang`).

Windows (Visual Studio 2022, from a Developer Command Prompt):

```
cmake -S native\compressor -B build\compressor
cmake --build build\compressor --config Release
ctest --test-dir build\compressor -C Release --output-on-failure
```

Options:

| Option | Default | Effect |
|---|---|---|
| `PROJECTO_SANITIZE` | OFF | AddressSanitizer and UBSan for project code (GCC and Clang; address only on MSVC). Turns off the hardening flags and static linking. |
| `PROJECTO_BUILD_TESTS` | ON | Build the doctest suite and register it with ctest. |
| `PROJECTO_HARDEN` | ON | GCC and Clang on non-Windows: `-fstack-protector-strong` and `-D_FORTIFY_SOURCE=3` (not in Debug) for project code and the zstd/brotli sources, relro and now, and `-static-pie` (or `-static`) for `projecto-compress`. On Linux the configure step fails when neither static mode links. |

Release builds use `-O2` (GCC and Clang), for project code and the dependencies.

Project sources build with `-Wall -Wextra -Wpedantic -Wshadow -Werror` (MSVC: `/W4 /WX`). The pinned dependencies are built without those flags.

`ctest` registers every doctest case. Two cases need minutes at level 22 (a 129 MiB zstd window-28 proof and the 16/17 MiB
brotli large-window proof). They run only with `PROJECTO_LARGE_TESTS=1` and show as skipped otherwise:

```
PROJECTO_LARGE_TESTS=1 ctest --test-dir build/compressor --output-on-failure
```

The decoders (libzstd's decompression side and brotlidec) are linked into the test binary only.

For an offline build, point `FETCHCONTENT_SOURCE_DIR_ZSTD`, `FETCHCONTENT_SOURCE_DIR_BROTLI` and `FETCHCONTENT_SOURCE_DIR_DOCTEST` at unpacked, hash-checked trees.

## Pinned dependencies

| Library | Version | Hash source |
|---|---|---|
| zstd | 1.5.7 | `zstd-1.5.7.tar.gz.sha256` published with the release |
| brotli | 1.2.1 | no published checksum; hash of the tag archive, cross-checked against `git archive` of the tag commit (db24a98) |
| doctest | 2.5.3 | the release asset's digest published by GitHub |

GitHub does not guarantee that a tag archive (`/archive/refs/tags/...`) stays byte-identical over time. If GitHub ever
regenerates the brotli archive, the configure step fails on the hash (it fails closed, it never builds unchecked code).
The fix is then to re-verify the new archive against `git archive` of commit
`db24a98aed38a16de78cc05ca15cdd8dc2a0d92d` and update the hash, or to vendor the tree and use `FETCHCONTENT_SOURCE_DIR_BROTLI`.

zstd is also asserted at compile time (`static_assert` on `ZSTD_VERSION_NUMBER` in `src/version.cpp`) and at run time, because
`ZSTD_STATIC_LINKING_ONLY` APIs are only safe against the pinned release. Bump a pin only in a reviewed change that updates the URL, the hash,
the constants in `src/version.cpp` and, for zstd, the memory estimates in `phase4-amendments.md` A6.

## Layout

```
CMakeLists.txt
cmake/Dependencies.cmake     pinned FetchContent
include/projecto/            cli, paths, protocol, exit_code, file_io, version, app,
                             codec_common, budget_allocator, zstd_codec, brotli_codec
src/                         one .cpp per header, plus main.cpp
tests/                       doctest suites (ctest registers every test case)
```

Portable C++20: only the standard library plus the two C libraries. No platform headers, no compiler extensions.
C stdio opens files with narrow paths, which is fine for the generated ASCII names this binary is given.
