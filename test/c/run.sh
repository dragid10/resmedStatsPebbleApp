#!/bin/sh
# Build and run the host-side C unit tests for the watch logic.
set -e
cd "$(dirname "$0")/../.."

# Inside a toolbox/distrobox without a C toolchain (e.g. the Pebble SDK
# container), run on the host instead.
if ! command -v "${CC:-cc}" >/dev/null 2>&1 && command -v host-spawn >/dev/null 2>&1; then
    exec host-spawn sh test/c/run.sh
fi

mkdir -p build/test
${CC:-cc} -std=c99 -Wall -Wextra -Werror -I src/c \
    src/c/stats_logic.c test/c/test_stats_logic.c -o build/test/test_stats_logic
./build/test/test_stats_logic
