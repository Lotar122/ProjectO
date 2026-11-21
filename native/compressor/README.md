# projecto-compress

Command-line compressor for the order archiver (zstd and brotli, statically linked).
The contract is in `phases-bugfix/phase4.md` sections 7 and 8, amended by `phases-bugfix/phase4-amendments.md`.

Status: W17 (CLI, paths, protocol) and W18 (zstd and brotli codecs, memory budget, counting allocator).

## Usage

```
projecto-compress --version
projecto-compress compress --codec zstd|br --root <abs dir> --input <abs file> --output <abs file>
                  --input-size <bytes> [--memory-budget-mib <n>] [--max-window-log <n>]
                  [--progress-interval-mib <n>] [--threads <n>] [--watch-stdin 0|1]
```

| Flag | Rule |
|---|---|
| `--codec` | exactly `zstd` or `br` |
| `--root` | absolute, exists, a directory, not a symlink |
| `--input` | absolute, a regular file (no symlink) with no other hard link, a direct child of the root, size equals `--input-size` |
| `--output` | absolute, a direct child of the root, a different file name than the input, must not exist (created exclusively, mode 0600 on POSIX) |
| `--input-size` | whole decimal number, 1 to 2^30 |
| `--memory-budget-mib` | 64 to 7168, default 6144 |
| `--max-window-log` | 10 to 28, default 28 |
| `--progress-interval-mib` | 1 to 1024, default 64 |
| `--watch-stdin` | `0` (default) or `1`: exit 3 and remove the partial output as soon as stdin reaches end of file |
| `--threads` | 0 to 64, default 4: zstd compression threads (see "zstd threads" below); `0` and `1` are single-threaded. Accepted and ignored for `br` |

Each flag takes its value as the next token (`--flag value`, not `--flag=value`) and may appear once.
An unknown, duplicate or missing flag is a usage error. The binary reads no environment variables.

stdout carries JSON lines (at most 4 KiB each); stderr carries human-readable text.

| Exit code | `error` in the result line | Meaning | Output file |
|---|---|---|---|
| 0 | (ok) | success | complete, kept |
| 2 | `usage` | usage or validation: a bad, unknown, duplicate or missing flag, a path rule, an input whose size or link count does not match before it is opened | never created |
| 3 | `io` | I/O: reading the input (including a size or type change seen on the open handle), a filesystem call that fails while the paths are checked (inspecting or canonicalising the root, inspecting the input or its link count or size, inspecting the output), writing or syncing the output, writing a `start` or `progress` line to stdout, `--watch-stdin 1` seeing end of file on stdin | removed |
| 3 | `io` | the `result` line could not be written to stdout after the output was committed (stderr names the path) | complete, kept: the caller removes it |
| 4 | `memory_budget` | the estimate is over `--memory-budget-mib`, or the counting allocator refused an allocation that would pass the budget | removed (or never created) |
| 5 | `codec` | zstd or brotli reported an error that no allocation failure explains. Also reported when zstd cannot create its worker threads (for example `pthread_create` fails with EAGAIN under a container `pids_limit`), with an "Allocation error" message from zstd; retry with `--threads 1` | removed |
| 70 | `internal` | `malloc` returned null for an allocation the budget allowed (the system is out of memory; stderr says "out of memory"), or another internal failure: a context that cannot be created, a zstd without multithreading asked for workers, a watch thread that cannot start or a signal wait that fails, an uncaught exception | removed |
| signal | (none) | SIGTERM, SIGINT or SIGHUP: the partial output is removed, then the process dies of that signal (status 143 for SIGTERM in a shell) | removed |

Only 4 is a budget refusal; a `malloc` failure within the budget is 70, never 4. A failing run prints one `result`
line with `"ok":false` (when stdout can still be written) and a message on stderr, except where a watch thread ends
the process at once (`--watch-stdin` end of file, exit 3; a failed signal wait, exit 70) or a signal does: those
print only the stderr message, because the main thread may be in the middle of a stdout line.
A crash (SIGSEGV, SIGABRT) or a SIGKILL can leave a partial output behind; the caller removes its temp files on
every path. `src/app/server-functions/orders/nativeCompressor.js` relies on this table: it skips brotli on 4 and
treats every other non-zero exit or signal as a failed run.

Known gap: zstd 1.5.7 dereferences a null pointer when one of the small blocks of its multithreaded setup cannot be
allocated (`ZSTD_customCalloc` writes to the result before checking it; fixed upstream after 1.5.7 in commit
`3f8f9b3f`, not in a release). A `malloc` failure or a budget refusal at exactly that point, before any worker has
started, ends the run with SIGSEGV instead of 70 or 4. The blocks are a few KiB and the pre-check keeps the budget
far above them, so in practice only a system out of memory at that moment reaches it.

```
$ projecto-compress --version
{"type":"version","version":"1.0.0","zstd":"1.5.7","brotli":"1.2.1"}
```

A `compress` run prints one `start` line, a `progress` line each time another `--progress-interval-mib` of input
has been read, and one `result` line:

```
{"type":"start","codec":"zstd","level":22,"windowLog":24,"chainLog":25,"hashLog":25,"searchLog":9,"minMatch":3,"targetLength":999,"strategy":9,"ldm":true,"ldmHashLog":20,"ldmMinMatch":32,"ldmBucketSizeLog":8,"ldmHashRateLog":4,"threads":4,"workers":4,"jobSize":2097152,"overlapLog":6,"estimatedBytes":1138061944,"budgetBytes":6442450944}
{"type":"progress","read":2097152,"written":98304}
{"type":"result","ok":true,"codec":"zstd","inputSize":10427088,"outputSize":1426963,"peakBytes":1113634448,"workers":4,"elapsedMs":41294,"encoder":"projecto-compress/1.0.0 zstd/1.5.7"}
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
  up to 4096 live blocks; zstd keeps 2 live, brotli about 25 at a 64 MiB input); over budget is exit 4.
- A counting allocator backs both libraries and refuses any allocation above the budget (also exit 4). `peakBytes` is
  its high-water mark, block headers included. brotlienc is built with `BROTLI_ENCODER_CLEANUP_ON_OOM`, because its
  default reaction to a failed allocation is `exit(1)`. A `malloc` failure within the budget is not a budget refusal:
  it is exit 70 with an "out of memory" message. A recorded failure is cleared once it has been reported, so it is
  never blamed for a later, unrelated library error.
- The pinned zstd is built with `ZSTD_MULTITHREAD`, like the system libzstd the table in `phase4-amendments.md` A6
  was measured with, so the single-threaded estimates match that table exactly (a single-threaded build would be one
  pointer, 8 bytes, lower; `tests/zstd_plan_tests.cpp` fails on such a build).
- `progress` lines: `read` is the input read so far, except with zstd workers, where it is the input the jobs have
  compressed so far (the file is read up to a window ahead of the jobs, so bytes read would reach the end long
  before the work does).

## zstd threads

`--threads N` (default 4) runs zstd with `ZSTD_c_nbWorkers`. Brotli has no multithreaded encoder and ignores it.

- Jobs: the input is cut into jobs of `clamp(2^windowLog / 8, 512 KiB, 8 MiB)` bytes (`ZSTD_c_jobSize`), and each job
  reloads exactly one job size of the input before it (`ZSTD_c_overlapLog = 9 - log2(2^windowLog / jobSize)`). zstd's
  default overlap with LDM is the whole window, and zstd raises the job size to the overlap, so without this every
  file would be a single job. LDM still covers the whole window: zstd runs it once over the input, in order, and
  hands each job its sequences. The layout depends on the size alone, so the output is the same for any worker
  count from 2 up; it differs from the single-threaded output, but is the same kind of frame (one frame, content
  size and checksum, `windowLog` as planned) and decodes with the same `ZSTD_d_windowLogMax`.
- Workers: `min(N, number of jobs)`, then lowered one at a time while the estimate below plus the header allowance
  (`fitsBudget`) is over `--memory-budget-mib`. Below 2 the run is single-threaded (`workers` 0) and the
  single-threaded estimate decides as before (exit 4 if it is over too). So a small budget costs speed, never a
  refusal that a smaller worker count would avoid. A file of one job (up to 512 KiB, or up to the job size) is
  always single-threaded. The start line reports `threads` (as given), `workers` (the `nbWorkers` used, 0 for
  single-threaded), `jobSize`, `overlapLog` and `estimatedBytes` for that worker count; the result line reports
  `workers` as read back from the zstd context.
- Memory: for n workers, with W = 2^windowLog and J = jobSize (`zstdEstimate`, sizes from zstdmt of 1.5.7):

  ```
  n * (worker context + 64 KiB)              worker context: ZSTD_estimateCCtxSize_usingCCtxParams, LDM off
  + max(W, n * J) + 3 * J                    input ring buffer (keeps the window for LDM)
  + (2n + 3) * ZSTD_compressBound(J)         output buffers
  + 2^ldmHashLog * 8 + 2^(ldmHashLog - ldmBucketSizeLog)   shared LDM tables
  + n * (J / ldmMinMatch) * 12               LDM sequence buffers
  + 1 MiB                                    MT context, job table, thread pool, pools
  ```

  Every allocation, also those on the worker threads, still goes through the counting allocator, which is now
  thread-safe (lock-free atomics); the budget stays a hard cap. Thread stacks are not counted (they are not
  allocated through zstd). Tests check the measured peak against the estimate (8 MiB with 2 and 4 workers, 64 MiB
  with 2: peak 95 to 98% of the estimate).

  | Input | jobs (size) | 1 thread | 2 workers | 3 workers | 4 workers | workers at 6144 / 7168 MiB |
  |---|---|---|---|---|---|---|
  | 8 MiB | 8 (1 MiB) | 142 MiB | 282 MiB | 414 MiB | 546 MiB | 4 / 4 |
  | 32 MiB | 8 (4 MiB) | 434 MiB | 863 MiB | 1258 MiB | 1652 MiB | 4 / 4 |
  | 64 MiB | 8 (8 MiB) | 738 MiB | 1466 MiB | 2126 MiB | 2787 MiB | 4 / 4 |
  | 128 MiB | 16 (8 MiB) | 1346 MiB | 2586 MiB | 3758 MiB | 4931 MiB | 4 / 4 |
  | 129 MiB to 1 GiB | up to 128 (8 MiB) | 2562 MiB | 4826 MiB | 7022 MiB | 9219 MiB | 2 / 3 |

  So 4 workers cost about 4 times the memory of one thread.
- Speed, measured on a 4-core, 8-thread laptop (i7-8550U), 1 thread against 4: 3 MiB 2.4x, 8 MiB 2.3x, a 10 MB
  text file 1.4x, 32 MiB 1.7x, 64 MiB 1.6x, a 17 MB very repetitive text 1.3x. Each job reindexes the input it
  reloads, so the total CPU time is about twice that of one thread; expect roughly 1.4 to 1.7x on files of 10 to
  64 MiB, not 4x, and none at all when the container gets one CPU (then pass `--threads 1`). Output sizes stayed
  within 0.3% of the single-threaded ones (some were smaller).
- Stopping: SIGTERM, SIGINT, SIGHUP and `--watch-stdin` end the process at once as before, workers included (they
  are threads of the process; they are created after the stop signals are blocked, so the signal watch thread
  still receives them). On a failure (a write error, a refused allocation on a worker, a read error) the partial
  output is removed first. zstd cannot cancel a job, and freeing the context lets the running jobs and one queued
  job finish (two job durations, which can be tens of seconds at level 22), so `main()` leaves the context and its
  allocator alive and exits right after reporting the failure; the process exit ends the workers. Code that calls
  `runApp`/`compressZstd` in-process (the tests) keeps the default `WorkerCleanup::wait` and does wait. Exit codes
  are unchanged.
- With workers the output is copied out in steps of 16 KiB: `ZSTD_compressStream2(ZSTD_e_end)` returns only when
  the frame is done or the output buffer is full, and the input is usually buffered before that call, so a 1 MiB
  step would hold all output (and so any write error and all progress) back until the end.
- Thread stacks: zstd creates its workers with default thread attributes. On musl (the Alpine image) a default
  thread stack is 128 KiB unless the executable asks for more, so on Linux `projecto-compress` is linked with
  `-z stack-size=1048576`, which musl uses as the default for every thread (glibc ignores it and takes
  RLIMIT_STACK, 8 MiB by default). The stacks are reserved address space, committed only as used. A level-22 worker
  needs far less: a 4-worker run on 16 MiB still succeeds with 24 KiB stacks on glibc x86_64 (fails at 16 KiB).
  `tests/posix_failure_tests.sh` runs 4 workers with `ulimit -s 128`, which on glibc gives every thread a musl-sized
  stack; the doctest binary is not linked with the flag, so ctest on musl runs its multithreaded cases at musl's
  default 128 KiB.
- Build: `cmake/Dependencies.cmake` sets `ZSTD_MULTITHREAD_SUPPORT` (zstd's own option, which defines
  `ZSTD_MULTITHREAD` and links pthreads). The binary stays static (`-static-pie`, else `-static`); pthreads are part
  of the C library on glibc 2.34+ and musl. A zstd without multithreading refuses `nbWorkers > 0`; the binary then
  fails every zstd run with `--threads` 2 or more with exit 70 instead of quietly running on one thread.

## musl check

The Alpine image is the only musl build, and its default thread stack is 128 KiB. This check, run by hand because the
Docker socket is closed to agents, shows that 4 zstd workers at level 22 finish on musl. From the repository root:

```
docker build --target native -t projecto-native -f docker/web-supervised.Dockerfile .
docker run --rm projecto-native sh -c '
	mkdir -p /tmp/musl-check
	seq 1 12000000 | head -c 67108864 > /tmp/musl-check/in.txt
	size=$(stat -c %s /tmp/musl-check/in.txt)
	/src/build/projecto-compress compress --codec zstd --root /tmp/musl-check \
		--input /tmp/musl-check/in.txt --output /tmp/musl-check/out.zst \
		--input-size "$size" --threads 4
	rc=$?
	echo "exit $rc"
	exit $rc
'
```

The build step runs ctest, so the stage already fails if a test fails. The compress run must print a `start` line with
`"workers":4`, a `result` line with `"ok":true` and `"workers":4`, and `exit 0`; a crash (segmentation fault) means the
stack size link flag did not take effect. Level 22 is the only zstd level this binary uses, so no level flag exists.
The 64 MiB input needs about 2.8 GiB of the default 6144 MiB budget at 4 workers (table above).

## Files

- On POSIX the output is created with `open(O_CREAT | O_EXCL | O_NOFOLLOW, 0600)`, so only the owner can read it
  (a stricter umask can only remove bits). On Windows it is created with `fopen(..., "wbx")` and inherits the
  directory's ACL. The OS-specific calls are all in `src/platform.cpp`.
- Before the output counts as committed it is flushed and `fsync`ed (`_commit` on Windows), then closed.
- On every failure before commit the binary removes the output it created. It never removes a file it did not create.
- Once committed, the output is complete and is never removed: if the final `result` line cannot be written to stdout,
  the run exits 3 and says on stderr where the complete output was kept. The caller removes it with its other temp files.
- SIGPIPE is ignored (where the platform has it), so a reader that goes away makes the next stdout write fail:
  exit 3 and the partial output is removed, instead of a signal death that would leave it behind.
- SIGTERM, SIGINT and SIGHUP are taken over by a watch thread (POSIX): the partial output is removed, then the process
  dies of the same signal. A signal the parent set to be ignored stays ignored. If waiting for the signals ever fails,
  the partial output is removed and the run exits 70, instead of carrying on deaf to SIGTERM.
- `--watch-stdin 1` makes the run end promptly when its parent dies without stopping it (for example a SIGKILLed or
  OOM-killed worker): a thread reads stdin and, at end of file or on an error, removes the partial output and exits 3.
  The parent must give the child a pipe as stdin and keep its end open (never write to it, never close or `end()` it)
  for as long as the run should continue. With stdin at `/dev/null` (Node's `stdio: "ignore"`), the run exits at once.
  A stdin the parent left non-blocking is waited on with `poll()`; only end of file or a read error counts as closed.
  Once the output is committed the outcome is decided, and a stdin that closes after that no longer changes it: a
  successful run still exits 0.
- `tests/posix_failure_tests.sh` (registered with ctest on POSIX systems) covers, for both codecs: a closed stdout pipe,
  an output over the file size limit, SIGTERM mid-run, `--watch-stdin` with the stdin writer SIGKILLed mid-run and with
  stdin already at end of file, and the 0600 output mode; plus a hard-linked input and a FIFO input. The zstd runs on
  its 16 MB input use the default 4 workers (checked on the start line), and an output write failing mid-run with
  `--threads 4` and `--threads 1` must exit 3 without output within 20 seconds. It also checks, for both codecs, that
  a `result` line written to a stdout whose reader left after the `start` line is exit 3 with the complete output
  kept, and that a `malloc` failure within the budget (address space capped with `ulimit -v`) is exit 70 with no
  output (skipped for a binary that cannot start under the cap, such as a sanitizer build); and that 4 zstd workers
  run with 128 KiB stacks. `tests/roundtrip_tests.cpp` drives the out-of-memory path in-process through
  `BudgetAllocator`'s injectable system allocator: at context creation, mid-stream (brotli) and on a zstd worker.
- The input is checked again after it is opened, on the open handle itself (`fstat`): a regular file with a single
  hard link and the size given by `--input-size`. On POSIX the open uses `O_NOFOLLOW` (a symlink swapped in is
  refused), `O_NONBLOCK` (a FIFO swapped in cannot hang the open) and `O_NOCTTY` (a terminal swapped in never becomes
  the controlling terminal). Exactly that many bytes are compressed, then
  end of file is required; anything else is exit 3. The handle is not bound to the inode seen at validation, but every
  rule is checked again on the handle, so whatever is read satisfies them. The root is a private temp directory.

## Build

Requires CMake 3.24 or newer, a C++20 compiler (GCC or Clang on Linux, MSVC on Windows), git, and network access for the
first configure (zstd and doctest are fetched by URL and checked against a pinned SHA256, brotli is cloned with git and
checked out at a pinned full commit id; see `cmake/Dependencies.cmake`).
The configure step stops with a message on a compiler older than GCC 13.1, Clang 17, AppleClang 15 or MSVC 19.30
(Visual Studio 2022), and on a standard library without C++20 `<format>`, `<ranges>` and `<span>`.

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
| `PROJECTO_HARDEN` | ON | GCC and Clang on non-Windows: `-fstack-protector-strong` and `_FORTIFY_SOURCE` (not in Debug) for project code and the zstd/brotli sources, relro and now, and `-static-pie` (or `-static`) for `projecto-compress`. The fortify level is the highest of 3 and 2 that compiles without a warning on this toolchain (level 3 needs GCC 12 or Clang 9 with glibc 2.34), otherwise none; the configure output names the level. On Linux the configure step fails when neither static mode links. |
| `PROJECTO_WERROR` | ON | Warnings in project code are errors (`-Werror`, MSVC `/WX`). Turn it off to build with a compiler newer than the tested ones that adds warnings. |

Release builds use `-O2` (GCC and Clang), for project code and the dependencies.

Project sources build with `-Wall -Wextra -Wpedantic -Wshadow` (MSVC: `/W4`), plus `-Werror` (`/WX`) unless `PROJECTO_WERROR` is off. The pinned dependencies are built without those flags.

Sanitizer builds run the tests with `ASAN_OPTIONS=allocator_may_return_null=1`, because one allocator test needs an
impossible `malloc` to return null.

`ctest` registers every doctest case. The multithreaded cases check that the worker threads really ran side by side
(process CPU time above 1.25 times the wall time) only on machines with at least 2 hardware threads. Two cases need minutes at level 22 (a 129 MiB zstd window-28 proof and the 16/17 MiB
brotli large-window proof). They run only with `PROJECTO_LARGE_TESTS=1` and show as skipped otherwise:

```
PROJECTO_LARGE_TESTS=1 ctest --test-dir build/compressor --output-on-failure
```

The decoders (libzstd's decompression side and brotlidec) are linked into the test binary only.

For an offline build, point `FETCHCONTENT_SOURCE_DIR_ZSTD`, `FETCHCONTENT_SOURCE_DIR_BROTLI` and `FETCHCONTENT_SOURCE_DIR_DOCTEST` at
unpacked, checked trees (zstd and doctest: the release archives with the hashes below; brotli: a checkout of the
commit below). These overrides are not checked by the configure step. Without them, git is only needed for brotli.

## Pinned dependencies

| Library | Version | Hash source |
|---|---|---|
| zstd | 1.5.7 | `zstd-1.5.7.tar.gz.sha256` published with the release |
| brotli | 1.2.1 | git commit `db24a98aed38a16de78cc05ca15cdd8dc2a0d92d` (the lightweight tag `v1.2.1`), cloned from `https://github.com/google/brotli.git` |
| doctest | 2.5.3 | the release asset's digest published by GitHub |

Brotli publishes no source archive or checksum for 1.2.1, and GitHub does not guarantee that its generated tag archives
(`/archive/refs/tags/...`) stay byte-identical, so a SHA256 of one is not a stable pin. A full commit id is: it names
the whole tree, and git refuses a checkout whose objects do not match it. After the clone, the configure step checks
that `HEAD` is exactly that commit and that the checkout has no local changes, so a build directory reused from an
older pin or an edited `_deps/brotli-src` fails instead of building other code. The check lists untracked and ignored files too, because brotli's build globs every `.c` file in `c/common`, `c/dec`
and `c/enc`, so a stray file there would be compiled in. The configure step runs it between the clone and brotli's
`add_subdirectory`, so brotli's `CMakeLists.txt` is not executed from an unverified tree. The clone holds every
file of the 1.2.1 tag archive pinned before (SHA256 `98d35d11...`) with the same content, and adds the files the
archive leaves out through `export-ignore` (test data, other language bindings), none of which the build uses.
The clone is a full one (about 45 MB), because git cannot shallow-clone a bare commit id.

zstd is also asserted at compile time (`static_assert` on `ZSTD_VERSION_NUMBER` in `src/version.cpp`) and at run time, because
`ZSTD_STATIC_LINKING_ONLY` APIs are only safe against the pinned release. Bump a pin only in a reviewed change that updates the URL, the hash
(or, for brotli, the commit), the constants in `src/version.cpp` and, for zstd, the memory estimates in `phase4-amendments.md` A6.

## Layout

```
CMakeLists.txt
cmake/Dependencies.cmake     pinned FetchContent
include/projecto/            cli, paths, protocol, exit_code, file_io, version, app,
                             codec_common, budget_allocator, zstd_codec, brotli_codec,
                             pending_outputs, platform
src/                         one .cpp per header, plus main.cpp
tests/                       doctest suites (ctest registers every test case)
```

Portable C++20: the standard library plus the two C libraries. The only OS-specific code is `src/platform.cpp`
(exclusive 0600 create, `O_NOFOLLOW`/`O_NONBLOCK`/`O_NOCTTY` open, `fstat`, `fsync`, the signal and stdin watches),
with a POSIX branch (Linux, macOS) and a Windows branch. `include/projecto/platform.hpp` is the one place that detects
the platform (`PROJECTO_PLATFORM_POSIX` or `PROJECTO_PLATFORM_WINDOWS`); any other platform stops the build with
`#error`. Files are opened with narrow paths, which is fine for the generated ASCII names this binary is given.

### Known limits on Windows

The Windows branch runs the same compression, but its process plumbing is weaker than on POSIX:

- There is no signal watch. Ctrl+C, Ctrl+Break or `TerminateProcess` end the run without removing the partial output.
- The input open has no counterpart to `O_NOFOLLOW`, `O_NONBLOCK` or `O_NOCTTY`; a reparse point or a named pipe
  swapped in for the input after validation is not refused at open time (the type, link count and size are still
  checked on the open handle).
- The output gets the directory's inherited ACL rather than an owner-only mode.
- The stdin watch relies on `_read` returning 0 or failing when the parent's end of the pipe goes away. With stdin on
  a console it waits for console input instead and never fires.
- `tests/posix_failure_tests.sh` does not run on Windows, so none of the process-level behaviour above is tested there.
