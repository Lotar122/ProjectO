#!/bin/sh
# POSIX-only paths of projecto-compress that need a real process:
#   - stdout is a pipe whose reader has gone (SIGPIPE): exit 3; a failed progress line leaves no
#     output, a failed result line keeps the complete output;
#   - the output cannot be written (file size limit, SIGXFSZ ignored so write() fails
#     with EFBIG): exit 3, no output left. A large output fails in a write, a small one
#     (held in the stdio buffer) at the final flush in commit;
#   - SIGTERM mid-run: the partial output is removed and the process dies of SIGTERM;
#   - --watch-stdin 1: the writer of stdin is SIGKILLed mid-run, so the run exits 3 at once
#     and removes the partial output; with stdin already at end of file it exits 3 at once;
#     with the writer alive for the whole run (stdin blocking or non-blocking) it exits 0 and
#     keeps the output; with stderr a full pipe the stop message cannot hang the exit;
#   - the output is created with mode 0600;
#   - an input with a second hard link, and a FIFO as input, are refused (exit 2) without hanging;
#   - multithreaded zstd: the zstd runs on long.bin use the default --threads 4 (8 jobs, 4 workers,
#     checked on the start line), so SIGTERM and --watch-stdin above stop running workers; an output
#     write failing mid-run with 4 workers (and with --threads 1) is exit 3 with no output left, and
#     the process does not wait for the jobs its workers are still running;
#   - the result line hits a stdout whose reader left after the start line: exit 3, output kept;
#   - malloc fails within the budget (ulimit -v): exit 70, not 4, and no output left;
#   - 4 zstd workers at level 22 with 128 KiB stacks (musl's default thread stack size).
# Usage: posix_failure_tests.sh <projecto-compress binary>
set -u

bin=$1
dir=$(mktemp -d) || exit 1
trap 'rm -rf "$dir"' EXIT
trap 'exit 1' INT TERM
failures=0

fail()
{
	echo "FAIL: $1"
	failures=$((failures + 1))
}

# check <name> <status> <expected status> <output path>: the status matches and no output is left.
check()
{
	if [ "$2" -ne "$3" ]
	then
		fail "$1: exit $2, expected $3"
	elif [ -e "$4" ]
	then
		fail "$1: $4 was left behind"
	else
		echo "ok: $1"
	fi
}

# Optional helpers for the cases a shell cannot set up alone; those cases are skipped without them.
perl=$(command -v perl || true)
timeout=$(command -v timeout || true)
# Sets O_NONBLOCK on stdin (as a parent sharing the open file description might), then execs the rest.
set_stdin_nonblocking='my $f = fcntl(STDIN, F_GETFL, 0) or die "F_GETFL: $!"; fcntl(STDIN, F_SETFL, $f | O_NONBLOCK) or die "F_SETFL: $!"; exec { $ARGV[0] } @ARGV or die "exec: $!"'
# Makes stderr a pipe that is already full and still has a reader (the exec'd process holds the
# read end but never reads it), then execs the rest: any blocking write to stderr would hang.
full_stderr='$^F = 255; pipe(my $r, my $w) or die "pipe: $!"; my $f = fcntl($w, F_GETFL, 0) or die "F_GETFL: $!"; fcntl($w, F_SETFL, $f | O_NONBLOCK) or die "F_SETFL: $!"; my $chunk = "x" x 4096; 1 while defined syswrite($w, $chunk); fcntl($w, F_SETFL, $f) or die "F_SETFL: $!"; open(STDERR, ">&", $w) or die "dup: $!"; exec { $ARGV[0] } @ARGV or die "exec: $!"'

size_of()
{
	wc -c < "$1" | tr -d ' '
}

compress()
{
	"$bin" compress --codec "$1" --root "$dir" --input "$dir/$2" --output "$dir/$3" --input-size "$4" --progress-interval-mib 1
}

# wait_for_file <path>: up to about 20 s for the path to appear.
wait_for_file()
{
	tries=0
	while [ ! -e "$1" ] && [ "$tries" -lt 200 ]
	do
		sleep 0.1
		tries=$((tries + 1))
	done
	[ -e "$1" ]
}

# About 1.7 MB of text: level 22 and q11 need far longer than the reader below takes to exit.
# The reader takes the first progress line and exits, so the later progress and result lines hit a closed pipe.
awk 'BEGIN { for (i = 0; i < 70000; i++) printf "  facet normal %d %d 0\n", i % 17, i }' > "$dir/text.bin"
# About 16 MB: level 22 and q11 take many seconds, long enough to be stopped mid-run.
awk 'BEGIN { for (i = 0; i < 650000; i++) printf "  facet normal %d %d 0\n", i % 17, i }' > "$dir/long.bin"
# Pseudo-random hex digits compress only to about half, so the outputs are a few KiB.
awk 'BEGIN { srand(1); for (i = 0; i < 65536; i++) printf "%x", int(rand() * 16) }' > "$dir/hex-large.bin"
awk 'BEGIN { srand(2); for (i = 0; i < 4000; i++) printf "%x", int(rand() * 16) }' > "$dir/hex-small.bin"

for codec in zstd br
do
	(
		compress "$codec" text.bin "pipe.$codec" "$(size_of "$dir/text.bin")" 2> "$dir/pipe-stderr"
		echo $? > "$dir/pipe-status"
	) | { read -r _line; sleep 1; }
	status=$(cat "$dir/pipe-status")
	if grep -q "result line" "$dir/pipe-stderr"
	then
		# Compression finished before the reader left: the complete output is kept.
		if [ "$status" -ne 3 ] || [ ! -s "$dir/pipe.$codec" ]
		then
			fail "$codec: stdout reader gone at the result line: exit $status, output kept: $([ -s "$dir/pipe.$codec" ] && echo yes || echo no)"
		else
			echo "ok: $codec: stdout reader gone at the result line (exit 3, output kept)"
		fi
		rm -f "$dir/pipe.$codec"
	elif grep -q "progress line" "$dir/pipe-stderr"
	then
		check "$codec: stdout reader gone (SIGPIPE)" "$status" 3 "$dir/pipe.$codec"
	else
		fail "$codec: no progress or result line error on stderr"
	fi

	# The same, but deterministic: no progress lines (the interval is larger than the input), and the
	# reader leaves right after the start line, long before compression ends. So the first write that
	# fails is the result line, after the commit: exit 3 and the complete output is kept.
	rm -f "$dir/kept.$codec"
	(
		"$bin" compress --codec "$codec" --root "$dir" --input "$dir/text.bin" --output "$dir/kept.$codec" \
			--input-size "$(size_of "$dir/text.bin")" --progress-interval-mib 1024 2> "$dir/kept-stderr"
		echo $? > "$dir/kept-status"
	) | { read -r _line; }
	status=$(cat "$dir/kept-status")
	if [ "$status" -ne 3 ] || [ ! -s "$dir/kept.$codec" ] || ! grep -q "complete output was kept" "$dir/kept-stderr"
	then
		fail "$codec: result line to a closed stdout: exit $status, output kept: $([ -s "$dir/kept.$codec" ] && echo yes || echo no), stderr: $(head -c 300 "$dir/kept-stderr")"
	else
		echo "ok: $codec: result line to a closed stdout (exit 3, complete output kept)"
	fi
	rm -f "$dir/kept.$codec"

	# malloc failing within the budget (the address space is capped far below the default 6 GiB
	# budget): exit 70, not the budget refusal 4, and no output left. zstd runs single-threaded so
	# that no thread stack competes for the capped address space. A binary that cannot even start
	# under the cap (a sanitizer build reserves terabytes of shadow memory) skips the case.
	if (ulimit -v 131072 && exec "$bin" --version) > /dev/null 2>&1
	then
		long_size=$(size_of "$dir/long.bin")
		(
			ulimit -v 131072
			exec "$bin" compress --codec "$codec" --root "$dir" --input "$dir/long.bin" --output "$dir/oom.$codec" \
				--input-size "$long_size" --threads 1 > "$dir/oom-stdout" 2> "$dir/oom-stderr"
		)
		status=$?
		check "$codec: malloc fails within the budget (exit 70)" "$status" 70 "$dir/oom.$codec"
		if ! grep -q "out of memory" "$dir/oom-stderr" || ! grep -q '"error":"internal"' "$dir/oom-stdout"
		then
			fail "$codec: no out-of-memory message: $(head -c 300 "$dir/oom-stderr")"
		fi
		rm -f "$dir/oom.$codec"
	else
		echo "skip: $codec: malloc fails within the budget (the binary does not start under ulimit -v)"
	fi

	for input in hex-large hex-small
	do
		(
			trap '' XFSZ
			ulimit -f 1
			exec "$bin" compress --codec "$codec" --root "$dir" --input "$dir/$input.bin" \
				--output "$dir/$input.$codec" --input-size "$(size_of "$dir/$input.bin")" > /dev/null 2>&1
		)
		check "$codec: output over the file size limit ($input)" "$?" 3 "$dir/$input.$codec"
	done

	# SIGTERM while the output is being written. The binary is started directly (not through the
	# compress function), so $! is its own pid and not that of a subshell.
	"$bin" compress --codec "$codec" --root "$dir" --input "$dir/long.bin" --output "$dir/term.$codec" \
		--input-size "$(size_of "$dir/long.bin")" > "$dir/term-stdout" 2> "$dir/term-stderr" &
	pid=$!
	if wait_for_file "$dir/term.$codec"
	then
		# Let the workers get going before the signal.
		sleep 1
		killed_at=$(date +%s)
		kill -TERM "$pid"
	else
		killed_at=$(date +%s)
	fi
	wait "$pid"
	status=$?
	took=$(( $(date +%s) - killed_at ))
	check "$codec: SIGTERM mid-run (dies of SIGTERM, 143)" "$status" 143 "$dir/term.$codec"
	if ! grep -q "stopped by a signal" "$dir/term-stderr"
	then
		fail "$codec: no signal message on stderr"
	fi
	if [ "$took" -gt 5 ]
	then
		fail "$codec: SIGTERM took $took s to end the run"
	fi
	if [ "$codec" = zstd ]
	then
		if grep -q '"threads":4,"workers":4' "$dir/term-stdout"
		then
			echo "ok: zstd: SIGTERM stopped a run with 4 workers"
		else
			fail "zstd: long.bin did not run on 4 workers: $(head -c 600 "$dir/term-stdout")"
		fi
	fi
	rm -f "$dir/term.$codec"

	# --watch-stdin 1: the process holding the write end of stdin is SIGKILLed, as a worker would be.
	rm -f "$dir/control"
	mkfifo "$dir/control"
	"$bin" compress --codec "$codec" --root "$dir" --input "$dir/long.bin" --output "$dir/orphan.$codec" \
		--input-size "$(size_of "$dir/long.bin")" --watch-stdin 1 < "$dir/control" > /dev/null 2> "$dir/orphan-stderr" &
	pid=$!
	sleep 60 > "$dir/control" &
	holder=$!
	if wait_for_file "$dir/orphan.$codec"
	then
		kill -KILL "$holder"
	fi
	wait "$pid"
	status=$?
	kill -KILL "$holder" 2> /dev/null
	wait "$holder" 2> /dev/null
	check "$codec: --watch-stdin, stdin writer killed mid-run" "$status" 3 "$dir/orphan.$codec"
	if ! grep -q "stdin was closed" "$dir/orphan-stderr"
	then
		fail "$codec: no stdin message on stderr"
	fi
	rm -f "$dir/orphan.$codec" "$dir/control"

	"$bin" compress --codec "$codec" --root "$dir" --input "$dir/long.bin" --output "$dir/eof.$codec" \
		--input-size "$(size_of "$dir/long.bin")" --watch-stdin 1 < /dev/null > /dev/null 2>&1
	check "$codec: --watch-stdin with stdin at end of file exits at once" "$?" 3 "$dir/eof.$codec"
	rm -f "$dir/eof.$codec"

	# --watch-stdin 1 with the writer of stdin alive for the whole run: exit 0 and the output is
	# kept, with stdin blocking and with stdin left non-blocking by the parent.
	for mode in blocking non-blocking
	do
		if [ "$mode" = non-blocking ] && [ -z "$perl" ]
		then
			echo "skip: $codec: --watch-stdin, $mode stdin held open (no perl)"
			continue
		fi
		rm -f "$dir/control" "$dir/held.$codec"
		mkfifo "$dir/control"
		if [ "$mode" = non-blocking ]
		then
			"$perl" -MFcntl -e "$set_stdin_nonblocking" "$bin" compress --codec "$codec" --root "$dir" \
				--input "$dir/hex-small.bin" --output "$dir/held.$codec" --input-size "$(size_of "$dir/hex-small.bin")" \
				--watch-stdin 1 < "$dir/control" > /dev/null 2>&1 &
		else
			"$bin" compress --codec "$codec" --root "$dir" --input "$dir/hex-small.bin" --output "$dir/held.$codec" \
				--input-size "$(size_of "$dir/hex-small.bin")" --watch-stdin 1 < "$dir/control" > /dev/null 2>&1 &
		fi
		pid=$!
		sleep 60 > "$dir/control" &
		holder=$!
		wait "$pid"
		status=$?
		kill -KILL "$holder" 2> /dev/null
		wait "$holder" 2> /dev/null
		if [ "$status" -ne 0 ] || [ ! -s "$dir/held.$codec" ]
		then
			fail "$codec: --watch-stdin, $mode stdin held open: exit $status, output kept: $([ -s "$dir/held.$codec" ] && echo yes || echo no)"
		else
			echo "ok: $codec: --watch-stdin, $mode stdin held open (exit 0, output kept)"
		fi
		rm -f "$dir/held.$codec" "$dir/control"
	done

	# Mode 0600 whatever the umask allows.
	(
		umask 022
		exec "$bin" compress --codec "$codec" --root "$dir" --input "$dir/hex-small.bin" \
			--output "$dir/mode.$codec" --input-size "$(size_of "$dir/hex-small.bin")" > /dev/null 2>&1
	)
	status=$?
	mode=$(ls -l "$dir/mode.$codec" 2> /dev/null | cut -c 1-10)
	if [ "$status" -ne 0 ] || [ "$mode" != "-rw-------" ]
	then
		fail "$codec: output mode is '$mode' (exit $status), expected -rw-------"
	else
		echo "ok: $codec: output mode 0600"
	fi
	rm -f "$dir/mode.$codec"
done

# An output write failing mid-run while zstd workers are compressing: exit 3, the partial output is
# removed, and the process exits without waiting for the jobs its workers are still running (zstd
# cannot cancel a job, and on this input a job takes tens of seconds). The write fails as soon as the
# first job has produced output, a few seconds in; the limit is generous for slow machines.
for threads in 4 1
do
	started=$(date +%s)
	(
		trap '' XFSZ
		ulimit -f 4
		exec "$bin" compress --codec zstd --root "$dir" --input "$dir/long.bin" --output "$dir/fsize-mt.zst" \
			--input-size "$(size_of "$dir/long.bin")" --threads "$threads" > /dev/null 2> "$dir/fsize-stderr"
	)
	status=$?
	took=$(( $(date +%s) - started ))
	check "zstd --threads $threads: output over the file size limit mid-run (exit 3 after $took s)" "$status" 3 "$dir/fsize-mt.zst"
	if [ "$took" -gt 20 ]
	then
		fail "zstd --threads $threads: the failing run took $took s to end"
	fi
	rm -f "$dir/fsize-mt.zst"
done

# Thread stacks: musl gives a new thread 128 KiB of stack unless the binary asks for more, and zstd
# creates its workers with default attributes. glibc sizes thread stacks from RLIMIT_STACK, so a
# 128 KiB stack limit gives every thread here, the main thread included, a musl-sized stack: a full
# level-22 run with 4 workers must still succeed.
# The size is taken first: other tools may not run with so small a stack.
long_size=$(size_of "$dir/long.bin")
(
	ulimit -s 128
	exec "$bin" compress --codec zstd --root "$dir" --input "$dir/long.bin" --output "$dir/stack.zst" \
		--input-size "$long_size" --threads 4 > "$dir/stack-stdout" 2> "$dir/stack-stderr"
)
status=$?
if [ "$status" -ne 0 ] || [ ! -s "$dir/stack.zst" ] || ! grep -q '"threads":4,"workers":4' "$dir/stack-stdout"
then
	fail "zstd --threads 4 with 128 KiB stacks: exit $status, $(head -c 300 "$dir/stack-stderr")"
else
	echo "ok: zstd --threads 4 with 128 KiB stacks (4 workers, exit 0)"
fi
rm -f "$dir/stack.zst"

# A closed stdin while stderr is a full pipe nobody reads: the stop message is dropped after a short
# wait instead of blocking, so the run still exits 3 at once and removes the partial output.
if [ -n "$perl" ] && [ -n "$timeout" ]
then
	"$timeout" 30 "$perl" -MFcntl -e "$full_stderr" "$bin" compress --codec zstd --root "$dir" --input "$dir/long.bin" \
		--output "$dir/full-stderr.zst" --input-size "$(size_of "$dir/long.bin")" --watch-stdin 1 < /dev/null > /dev/null
	check "--watch-stdin with stderr full does not hang on the stop message" "$?" 3 "$dir/full-stderr.zst"
	rm -f "$dir/full-stderr.zst"
else
	echo "skip: --watch-stdin with stderr full (no perl or timeout)"
fi

# Inputs refused before anything is opened.
ln "$dir/hex-small.bin" "$dir/twin.bin"
"$bin" compress --codec zstd --root "$dir" --input "$dir/hex-small.bin" --output "$dir/twin.zst" \
	--input-size "$(size_of "$dir/hex-small.bin")" > /dev/null 2>&1
check "an input with a second hard link is refused" "$?" 2 "$dir/twin.zst"
rm -f "$dir/twin.bin"

mkfifo "$dir/fifo.bin"
"$bin" compress --codec zstd --root "$dir" --input "$dir/fifo.bin" --output "$dir/fifo.zst" \
	--input-size 1 > /dev/null 2>&1
check "a FIFO input is refused without blocking" "$?" 2 "$dir/fifo.zst"

if [ "$failures" -ne 0 ]
then
	exit 1
fi
exit 0
