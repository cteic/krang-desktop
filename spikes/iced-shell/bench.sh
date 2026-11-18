#!/bin/bash
# Measures the spike and prints one table. Linux only: it reads /proc, and
# it runs the app under a virtual display with the software renderer when
# there is no display. Numbers from a shared cloud machine without a GPU
# are not comparable with numbers from a Mac.
#
#   ./bench.sh            # everything but the clean build
#   BENCH_CLEAN_BUILD=1 ./bench.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=${BENCH_DIR:-$(mktemp -d)}
bin="$here/target/release/krang-shell"
results="$work/results.txt"
: > "$results"

if [ -z "${DISPLAY:-}" ]; then
  Xvfb :97 -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
  xvfb=$!
  export DISPLAY=:97
  trap 'kill $xvfb 2>/dev/null' EXIT
  sleep 1
fi
export ICED_BACKEND=${ICED_BACKEND:-tiny-skia}
export SHELL=${SHELL:-/bin/bash}
export KRANG_STATE_DIR="$work/state"
export KRANG_CLAUDE_BIN="$here/scripts/fake-agent"
export WEBKIT_DISABLE_COMPOSITING_MODE=1

row() { printf '| %-58s | %-28s | %s\n' "$1" "$2" "$3" | tee -a "$results"; }
value() { grep -m1 "^$1 " "$2" | cut -d' ' -f2-; }

# Resident memory of a process and its descendants, in MB.
tree_rss() {
  local total=0 pid
  for pid in $(pstree -p "$1" 2>/dev/null | grep -o '([0-9]*)' | tr -d '()'); do
    total=$((total + $(awk '/VmRSS/ {print $2}' /proc/$pid/status 2>/dev/null || echo 0)))
  done
  echo $((total / 1024))
}
rss() { echo $(( $(awk '/VmRSS/ {print $2}' /proc/$1/status 2>/dev/null || echo 0) / 1024 )); }
# CPU ticks used by one process so far.
ticks() { awk '{print $14 + $15}' /proc/$1/stat 2>/dev/null || echo 0; }
hz=$(getconf CLK_TCK)

echo "building release..." >&2
(cd "$here" && cargo build --release -q) || exit 1
mkdir -p "$work/layouts"
"$here/scripts/make-test-vault.py" "$work/vault" >/dev/null
for file in "$here"/bench/*.toml; do
  sed "s|VAULT|$work/vault|g; s|BENCH|$here/bench|g" "$file" > "$work/layouts/$(basename "$file")"
done

echo
row "Measure" "Value" "How"
row "---" "---" "---"

# Start-up: the first run after the binary is rewritten, then five more.
cp "$bin" "$work/krang-shell-cold"
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null && dropped=yes || dropped=no
start=$(date +%s%N)
KRANG_SELFTEST=first-frame "$work/krang-shell-cold" --fresh > "$work/cold.txt" 2>/dev/null
end=$(date +%s%N)
row "Cold start to first frame (in app / wall incl. exit)" "$(value first_frame_ms "$work/cold.txt") ms / $(( (end - start) / 1000000 )) ms" "new binary copy; page cache dropped: $dropped"
warm=()
for _ in 1 2 3 4 5 6; do
  KRANG_SELFTEST=first-frame "$bin" --fresh > "$work/warm.txt" 2>/dev/null
  warm+=("$(value first_frame_ms "$work/warm.txt")")
done
row "Warm start to first frame, median of 5" "$(printf '%s\n' "${warm[@]:1}" | sort -n | sed -n 3p) ms" "KRANG_SELFTEST=first-frame"

# Idle with one pane of each kind.
KRANG_SELFTEST=hold KRANG_SELFTEST_SECONDS=45 "$bin" --layout "$work/layouts/all-kinds.toml" > "$work/idle.txt" 2>/dev/null &
pid=$!
sleep 30
t0=$(ticks $pid); sleep 10; t1=$(ticks $pid)
row "Idle memory after 30 s, one pane of each kind" "$(rss $pid) MB app, $(tree_rss $pid) MB with children" "VmRSS; children: shell, web process"
row "Idle CPU, 10 s window after 30 s" "$(awk -v a="$t0" -v b="$t1" -v hz="$hz" 'BEGIN { printf "%.1f%%", (b - a) / hz / 10 * 100 }')" "/proc stat ticks of the app"
wait $pid

KRANG_SELFTEST=hold KRANG_SELFTEST_SECONDS=25 "$bin" --fresh > /dev/null 2>&1 &
pid=$!
sleep 15
t0=$(ticks $pid); sleep 10; t1=$(ticks $pid)
row "Idle CPU, one terminal only" "$(awk -v a="$t0" -v b="$t1" -v hz="$hz" 'BEGIN { printf "%.1f%%", (b - a) / hz / 10 * 100 }')" "no web pane: no GTK timer"
wait $pid

# Four terminals flooding, a fifth pinged once a second.
flood_seconds=${BENCH_FLOOD_SECONDS:-60}
KRANG_SELFTEST=flood KRANG_SELFTEST_SECONDS=$flood_seconds "$bin" --layout "$work/layouts/flood.toml" > "$work/flood.txt" 2>/dev/null &
pid=$!
sleep 3
peak=0; samples=""
t0=$(ticks $pid)
for _ in $(seq 1 $(( (flood_seconds - 6) / 3 ))); do
  sleep 3
  now=$(rss $pid); samples="$samples $now"
  [ "$now" -gt "$peak" ] && peak=$now
done
t1=$(ticks $pid)
row "Memory with 4 terminals flooding for ${flood_seconds} s" "peak $peak MB, last $now MB" "app VmRSS every 3 s:$(echo "$samples" | tr ' ' '\n' | sed -n '2p;$p' | tr '\n' ' ')"
row "CPU with 4 terminals flooding" "$(awk -v a="$t0" -v b="$t1" -v hz="$hz" -v s="$(( (flood_seconds - 6) / 3 * 3 ))" 'BEGIN { printf "%.0f%% of one core", (b - a) / hz / s * 100 }')" "app process only; the shells are separate"
wait $pid
row "Quiet terminal echo during flood (median / p99 / max)" "$(value quiet_terminal_echo_median_ms "$work/flood.txt") / $(value quiet_terminal_echo_p99_ms "$work/flood.txt") / $(value quiet_terminal_echo_max_ms "$work/flood.txt") ms" "$(value quiet_terminal_echo_count "$work/flood.txt") pings, $(value quiet_terminal_unanswered "$work/flood.txt") unanswered"

# The same flood in a tab that is not shown, with the quiet terminal in the shown tab.
KRANG_SELFTEST=flood KRANG_SELFTEST_SECONDS=30 "$bin" --layout "$work/layouts/quiet.toml" --layout "$work/layouts/flood.toml" > "$work/hidden.txt" 2>/dev/null &
pid=$!
sleep 10; t0=$(ticks $pid); sleep 10; t1=$(ticks $pid)
wait $pid
row "Flood in a hidden tab: app CPU / quiet echo median, p99" "$(awk -v a="$t0" -v b="$t1" -v hz="$hz" 'BEGIN { printf "%.0f%%", (b - a) / hz / 10 * 100 }') / $(value quiet_terminal_echo_median_ms "$work/hidden.txt"), $(value quiet_terminal_echo_p99_ms "$work/hidden.txt") ms" "hidden terminals parse but take no snapshots"

# Frame time while the divider moves every frame next to a busy terminal.
KRANG_SELFTEST=resize KRANG_SELFTEST_SECONDS=10 "$bin" --layout "$work/layouts/resize.toml" > "$work/resize.txt" 2>/dev/null
row "Frame time, divider moving, busy terminal (median / p99)" "$(value resize_frame_median_ms "$work/resize.txt") / $(value resize_frame_p99_ms "$work/resize.txt") ms" "$(value resize_frame_count "$work/resize.txt") frames, time between redraws"

# Editor: the 50,000-line note, typing, and vault search.
KRANG_SELFTEST=editor KRANG_SELFTEST_NOTE="Big note.md" "$bin" --layout "$work/layouts/editor.toml" > "$work/editor.txt" 2>/dev/null
row "Open the 50,000-line note (in update / to frame)" "$(value editor_open_ms "$work/editor.txt") / $(value editor_open_to_frame_ms "$work/editor.txt") ms" "$(value editor_open_lines "$work/editor.txt") lines"
row "Editor keystroke to frame (median / p99)" "$(value editor_key_to_frame_median_ms "$work/editor.txt") / $(value editor_key_to_frame_p99_ms "$work/editor.txt") ms" "100 keys into the 50,000-line note"
row "Editor update per keystroke (median / p99)" "$(value editor_update_median_ms "$work/editor.txt") / $(value editor_update_p99_ms "$work/editor.txt") ms" "time inside update()"
for query in "meeting" "zebra-unique-term" "#project" "the quick brown"; do
  row "Vault search: $query" "$(grep -F "search_ms[${query// /_}]" "$work/editor.txt" | cut -d' ' -f2-) ms" "$(value vault_notes "$work/editor.txt") notes, in memory"
done

KRANG_SELFTEST=terminal-latency "$bin" --fresh > "$work/term.txt" 2>/dev/null
row "Terminal key to echo (median / p99)" "$(value terminal_echo_median_ms "$work/term.txt") / $(value terminal_echo_p99_ms "$work/term.txt") ms" "through the shell and the pty"
row "Terminal key to frame (median / p99)" "$(value terminal_key_to_frame_median_ms "$work/term.txt") / $(value terminal_key_to_frame_p99_ms "$work/term.txt") ms" "until the frame with the echo is shown"

row "Binary size (release / stripped)" "$(( $(stat -c %s "$bin") / 1048576 )) MB / $(strip -o "$work/stripped" "$bin" && echo $(( $(stat -c %s "$work/stripped") / 1048576 ))) MB" "debug line tables kept in release"

# Build times. The incremental build changes one line and builds debug.
(cd "$here" && cargo build -q)
echo "// bench $(date +%s%N)" >> "$here/src/app/palette.rs"
start=$(date +%s%N); (cd "$here" && cargo build -q); end=$(date +%s%N)
sed -i '$ d' "$here/src/app/palette.rs"
(cd "$here" && cargo build -q)
row "Rebuild after one line (debug)" "$(awk -v n=$(( (end - start) / 1000000 )) 'BEGIN { printf "%.1f s", n / 1000 }')" "one line in src/app/palette.rs"
if [ -n "${BENCH_CLEAN_BUILD:-}" ]; then
  start=$(date +%s%N); (cd "$here" && CARGO_TARGET_DIR="$work/clean" cargo build --release -q); end=$(date +%s%N)
  row "Clean release build" "$(awk -v n=$(( (end - start) / 1000000 )) 'BEGIN { printf "%.0f s", n / 1000 }')" "$(nproc) cores, crates already downloaded"
fi
echo
echo "raw output in $work" >&2
