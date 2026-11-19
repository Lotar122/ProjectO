#!/bin/sh
# POSIX-only failure paths of projecto-compress that need a real process:
#   - stdout is a pipe whose reader has gone (SIGPIPE): exit 3, no output left;
#   - the output cannot be written (file size limit, SIGXFSZ ignored so write() fails
#     with EFBIG): exit 3, no output left. A large output fails in a write, a small one
#     (held in the stdio buffer) at the final flush in commit.
# Usage: posix_failure_tests.sh <projecto-compress binary>
set -u

bin=$1
dir=$(mktemp -d) || exit 1
trap 'rm -rf "$dir"' EXIT
trap 'exit 1' INT TERM
failures=0

check()
{
	name=$1
	status=$2
	output=$3
	if [ "$status" -ne 3 ]
	then
		echo "FAIL: $name: exit $status, expected 3"
		failures=$((failures + 1))
	elif [ -e "$output" ]
	then
		echo "FAIL: $name: $output was left behind"
		failures=$((failures + 1))
	else
		echo "ok: $name"
	fi
}

size_of()
{
	wc -c < "$1" | tr -d ' '
}

compress()
{
	"$bin" compress --codec "$1" --root "$dir" --input "$dir/$2" --output "$dir/$3" --input-size "$4" --progress-interval-mib 1
}

# About 1.7 MB of text: level 22 and q11 need far longer than the reader below takes to exit.
# The reader takes the first progress line and exits, so the later progress and result lines hit a closed pipe.
awk 'BEGIN { for (i = 0; i < 70000; i++) printf "  facet normal %d %d 0\n", i % 17, i }' > "$dir/text.bin"
# Pseudo-random hex digits compress only to about half, so the outputs are a few KiB.
awk 'BEGIN { srand(1); for (i = 0; i < 65536; i++) printf "%x", int(rand() * 16) }' > "$dir/hex-large.bin"
awk 'BEGIN { srand(2); for (i = 0; i < 4000; i++) printf "%x", int(rand() * 16) }' > "$dir/hex-small.bin"

for codec in zstd br
do
	(
		compress "$codec" text.bin "pipe.$codec" "$(size_of "$dir/text.bin")" 2> "$dir/pipe-stderr"
		echo $? > "$dir/pipe-status"
	) | { read -r _line; sleep 1; }
	check "$codec: stdout reader gone (SIGPIPE)" "$(cat "$dir/pipe-status")" "$dir/pipe.$codec"
	if ! grep -q -e "progress line" -e "result line" "$dir/pipe-stderr"
	then
		echo "FAIL: $codec: no progress or result line error on stderr"
		failures=$((failures + 1))
	fi

	for input in hex-large hex-small
	do
		(
			trap '' XFSZ
			ulimit -f 1
			exec "$bin" compress --codec "$codec" --root "$dir" --input "$dir/$input.bin" \
				--output "$dir/$input.$codec" --input-size "$(size_of "$dir/$input.bin")" > /dev/null 2>&1
		)
		check "$codec: output over the file size limit ($input)" "$?" "$dir/$input.$codec"
	done
done

if [ "$failures" -ne 0 ]
then
	exit 1
fi
exit 0
