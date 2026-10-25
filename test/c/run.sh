#!/bin/sh
# Build and run the host-side C unit tests for the watch logic.
set -e
cd "$(dirname "$0")/../.."
mkdir -p build/test
${CC:-cc} -std=c99 -Wall -Wextra -Werror -I src/c \
    src/c/stats_logic.c test/c/test_stats_logic.c -o build/test/test_stats_logic
./build/test/test_stats_logic
