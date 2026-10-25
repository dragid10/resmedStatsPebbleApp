#include "stats_logic.h"

#include <stdio.h>

StatLevel score_level(int score) {
    if (score >= SCORE_GOOD_THRESHOLD) return STAT_GOOD;
    if (score >= SCORE_OK_THRESHOLD) return STAT_OK;
    return STAT_BAD;
}

StatLevel ahi_level(int ahi_x10) {
    if (ahi_x10 < AHI_NORMAL_THRESHOLD_X10) return STAT_GOOD;
    if (ahi_x10 < AHI_MILD_THRESHOLD_X10) return STAT_OK;
    return STAT_BAD;
}

StatLevel usage_level(int usage_mins) {
    if (usage_mins >= USAGE_GOOD_THRESHOLD_MINS) return STAT_GOOD;
    if (usage_mins >= USAGE_OK_THRESHOLD_MINS) return STAT_OK;
    return STAT_BAD;
}

StatLevel mask_level(int mask_count) {
    if (mask_count < MASK_GOOD_THRESHOLD) return STAT_GOOD;
    if (mask_count < MASK_OK_THRESHOLD) return STAT_OK;
    return STAT_BAD;
}

StatLevel leak_level(int leak_pct) {
    if (leak_pct < LEAK_GOOD_THRESHOLD) return STAT_GOOD;
    if (leak_pct < LEAK_OK_THRESHOLD) return STAT_OK;
    return STAT_BAD;
}

/** Map a level to its label; only the bad label differs between stats. */
static const char *level_text(StatLevel level, const char *ok, const char *bad) {
    switch (level) {
        case STAT_GOOD: return "Good";
        case STAT_OK:   return ok;
        default:        return bad;
    }
}

const char *get_score_text(int score) {
    return level_text(score_level(score), "OK", "Poor");
}

const char *get_ahi_text(int ahi_x10) {
    return level_text(ahi_level(ahi_x10), "Mild", "High");
}

const char *get_usage_text(int usage_mins) {
    return level_text(usage_level(usage_mins), "OK", "Low");
}

const char *get_mask_text(int mask_count) {
    return level_text(mask_level(mask_count), "OK", "High");
}

const char *get_leak_text(int leak_pct) {
    return level_text(leak_level(leak_pct), "OK", "High");
}

int16_t clamp_int16(int32_t value, int16_t min_val, int16_t max_val) {
    if (value < min_val) return min_val;
    if (value > max_val) return max_val;
    return (int16_t)value;
}

void format_ahi(char *buf, size_t size, int ahi_x10) {
    snprintf(buf, size, "%d.%d /hr", ahi_x10 / 10, ahi_x10 % 10);
}

void format_usage(char *buf, size_t size, int usage_mins) {
    snprintf(buf, size, "%dh %02dm", usage_mins / 60, usage_mins % 60);
}

int wrap_day_index(int index, int delta, int total) {
    if (total <= 0) return 0;
    int wrapped = (index + delta) % total;
    return wrapped < 0 ? wrapped + total : wrapped;
}

int cooldown_minutes_remaining(time_t now, time_t last_sync, int cooldown_secs) {
    if (last_sync <= 0) return 0;
    time_t elapsed = now - last_sync;
    if (elapsed >= cooldown_secs) return 0;
    return (int)((cooldown_secs - elapsed) / 60) + 1;
}

time_t next_daily_wakeup(time_t now, time_t today_at_hour) {
    if (today_at_hour <= now + 60) {
        return today_at_hour + 24 * 3600;
    }
    return today_at_hour;
}

bool is_double_tap(uint64_t now_ms, uint64_t last_tap_ms) {
    if (last_tap_ms == 0 || now_ms < last_tap_ms) return false;
    uint64_t gap = now_ms - last_tap_ms;
    return gap >= DOUBLE_TAP_MIN_MS && gap <= DOUBLE_TAP_MAX_MS;
}
