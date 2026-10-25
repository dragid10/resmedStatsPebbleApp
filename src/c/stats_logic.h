/**
 * Pure logic for ResMed Stats: clinical thresholds, text indicators,
 * value formatting, and timing math.
 *
 * Kept free of pebble.h so it compiles with a host compiler for the unit
 * tests in test/c/ (run with `npm test`).
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>

// -- Clinical Thresholds --

/** myAir score >= this is considered good (green). */
#define SCORE_GOOD_THRESHOLD 70

/** myAir score >= this is considered okay (yellow). Below is bad (red). */
#define SCORE_OK_THRESHOLD 50

/**
 * AHI thresholds (stored as AHI × 10 to avoid floats).
 * < 5.0 events/hr (50) = normal, 5-15 (150) = mild, >15 = moderate/severe.
 */
#define AHI_NORMAL_THRESHOLD_X10 50
#define AHI_MILD_THRESHOLD_X10   150

/** Usage >= 7 hours (420 min) is good, >= 4 hours (240 min) is okay. */
#define USAGE_GOOD_THRESHOLD_MINS 420
#define USAGE_OK_THRESHOLD_MINS   240

/** Mask off: 0-1 removals is good, 2-3 is okay, 4+ is high. */
#define MASK_GOOD_THRESHOLD 2
#define MASK_OK_THRESHOLD   4

/** Leak: <20% is good, 20-40% is okay, >40% is high. */
#define LEAK_GOOD_THRESHOLD 20
#define LEAK_OK_THRESHOLD   40

/** How a stat compares to its clinical thresholds. */
typedef enum {
    STAT_GOOD,
    STAT_OK,
    STAT_BAD
} StatLevel;

StatLevel score_level(int score);
StatLevel ahi_level(int ahi_x10);
StatLevel usage_level(int usage_mins);
StatLevel mask_level(int mask_count);
StatLevel leak_level(int leak_pct);

// -- Text indicators --
// When enabled, these REPLACE numeric values with human-readable
// interpretations like "Good", "OK", "Poor".

const char *get_score_text(int score);
const char *get_ahi_text(int ahi_x10);
const char *get_usage_text(int usage_mins);
const char *get_mask_text(int mask_count);
const char *get_leak_text(int leak_pct);

/** Clamp a 32-bit value to a valid int16_t range. */
int16_t clamp_int16(int32_t value, int16_t min_val, int16_t max_val);

/** Format AHI × 10 as e.g. "3.2 /hr". */
void format_ahi(char *buf, size_t size, int ahi_x10);

/** Format usage minutes as e.g. "7h 05m". */
void format_usage(char *buf, size_t size, int usage_mins);

/** Move `index` by `delta` within [0, total), wrapping at both ends. */
int wrap_day_index(int index, int delta, int total);

/**
 * Whole minutes (rounded up) until a manual sync is allowed again,
 * or 0 if it's allowed now. `last_sync` of 0 means never synced.
 */
int cooldown_minutes_remaining(time_t now, time_t last_sync, int cooldown_secs);

/**
 * Pick the next daily wakeup: today's slot if it's more than a minute
 * away, otherwise the same time tomorrow.
 */
time_t next_daily_wakeup(time_t now, time_t today_at_hour);

/** Two taps count as a double tap when the second lands in this window. */
#define DOUBLE_TAP_MIN_MS 100
#define DOUBLE_TAP_MAX_MS 1500

/**
 * True when a tap at `now_ms` completes a double tap begun at `last_tap_ms`
 * (0 = no earlier tap). The minimum gap stops one shake that reports two
 * tap events from counting.
 */
bool is_double_tap(uint64_t now_ms, uint64_t last_tap_ms);
