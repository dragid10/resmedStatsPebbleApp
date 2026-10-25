/**
 * Host-side unit tests for src/c/stats_logic.c.
 * Build and run with `npm test` (or test/c/run.sh).
 */

#include <stdio.h>
#include <string.h>

#include "stats_logic.h"

static int s_failures = 0;
static int s_checks = 0;

#define CHECK(cond) do { \
    s_checks++; \
    if (!(cond)) { s_failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
} while (0)

#define CHECK_STR(actual, expected) do { \
    s_checks++; \
    if (strcmp((actual), (expected)) != 0) { \
        s_failures++; \
        printf("FAIL %s:%d: got \"%s\", want \"%s\"\n", __FILE__, __LINE__, (actual), (expected)); \
    } \
} while (0)

static void test_score_thresholds(void) {
    CHECK(score_level(100) == STAT_GOOD);
    CHECK(score_level(70) == STAT_GOOD);
    CHECK(score_level(69) == STAT_OK);
    CHECK(score_level(50) == STAT_OK);
    CHECK(score_level(49) == STAT_BAD);
    CHECK(score_level(0) == STAT_BAD);
    CHECK_STR(get_score_text(85), "Good");
    CHECK_STR(get_score_text(55), "OK");
    CHECK_STR(get_score_text(10), "Poor");
}

static void test_ahi_thresholds(void) {
    CHECK(ahi_level(0) == STAT_GOOD);
    CHECK(ahi_level(49) == STAT_GOOD);   // 4.9 events/hr
    CHECK(ahi_level(50) == STAT_OK);     // 5.0 is mild
    CHECK(ahi_level(149) == STAT_OK);
    CHECK(ahi_level(150) == STAT_BAD);   // 15.0 is moderate
    CHECK_STR(get_ahi_text(32), "Good");
    CHECK_STR(get_ahi_text(80), "Mild");
    CHECK_STR(get_ahi_text(200), "High");
}

static void test_usage_thresholds(void) {
    CHECK(usage_level(480) == STAT_GOOD);
    CHECK(usage_level(420) == STAT_GOOD);
    CHECK(usage_level(419) == STAT_OK);
    CHECK(usage_level(240) == STAT_OK);
    CHECK(usage_level(239) == STAT_BAD);
    CHECK_STR(get_usage_text(0), "Low");
}

static void test_mask_and_leak_thresholds(void) {
    CHECK_STR(get_mask_text(0), "Good");
    CHECK_STR(get_mask_text(1), "Good");
    CHECK_STR(get_mask_text(2), "OK");
    CHECK_STR(get_mask_text(3), "OK");
    CHECK_STR(get_mask_text(4), "High");
    CHECK_STR(get_leak_text(19), "Good");
    CHECK_STR(get_leak_text(20), "OK");
    CHECK_STR(get_leak_text(39), "OK");
    CHECK_STR(get_leak_text(40), "High");
}

static void test_clamp(void) {
    CHECK(clamp_int16(50, 0, 100) == 50);
    CHECK(clamp_int16(-5, 0, 100) == 0);
    CHECK(clamp_int16(100000, 0, 9999) == 9999);
    CHECK(clamp_int16(0, 0, 1440) == 0);
}

static void test_formatting(void) {
    char buf[32];
    format_ahi(buf, sizeof(buf), 32);
    CHECK_STR(buf, "3.2 /hr");
    format_ahi(buf, sizeof(buf), 0);
    CHECK_STR(buf, "0.0 /hr");
    format_ahi(buf, sizeof(buf), 150);
    CHECK_STR(buf, "15.0 /hr");
    format_usage(buf, sizeof(buf), 425);
    CHECK_STR(buf, "7h 05m");
    format_usage(buf, sizeof(buf), 59);
    CHECK_STR(buf, "0h 59m");
}

static void test_wrap_day_index(void) {
    CHECK(wrap_day_index(0, 1, 7) == 1);
    CHECK(wrap_day_index(6, 1, 7) == 0);    // past the oldest wraps to newest
    CHECK(wrap_day_index(0, -1, 7) == 6);   // before the newest wraps to oldest
    CHECK(wrap_day_index(0, -1, 1) == 0);
    CHECK(wrap_day_index(3, 1, 0) == 0);    // no data
}

static void test_cooldown(void) {
    int cooldown = 15 * 60;
    CHECK(cooldown_minutes_remaining(1000, 0, cooldown) == 0);        // never synced
    CHECK(cooldown_minutes_remaining(10000, 10000, cooldown) == 16);  // just synced
    CHECK(cooldown_minutes_remaining(10000 + 14 * 60, 10000, cooldown) == 2);
    CHECK(cooldown_minutes_remaining(10000 + cooldown - 1, 10000, cooldown) == 1);
    CHECK(cooldown_minutes_remaining(10000 + cooldown, 10000, cooldown) == 0);
}

static void test_next_daily_wakeup(void) {
    time_t nine_am = 1000000;
    time_t day = 24 * 3600;
    // Earlier in the day: today's 9 AM
    CHECK(next_daily_wakeup(nine_am - 3600, nine_am) == nine_am);
    // Already past: tomorrow's 9 AM
    CHECK(next_daily_wakeup(nine_am + 3600, nine_am) == nine_am + day);
    // Within a minute of the slot (e.g. the wakeup launch itself): tomorrow
    CHECK(next_daily_wakeup(nine_am, nine_am) == nine_am + day);
    CHECK(next_daily_wakeup(nine_am - 30, nine_am) == nine_am + day);
}

static void test_double_tap(void) {
    CHECK(!is_double_tap(5000, 0));          // first tap ever
    CHECK(is_double_tap(5300, 5000));        // 300 ms apart
    CHECK(is_double_tap(5150, 5000));        // edge of the window
    CHECK(is_double_tap(5700, 5000));
    CHECK(!is_double_tap(5050, 5000));       // one shake reporting twice
    CHECK(!is_double_tap(5701, 5000));       // too slow
    CHECK(!is_double_tap(4000, 5000));       // clock went backwards
}

int main(void) {
    test_score_thresholds();
    test_ahi_thresholds();
    test_usage_thresholds();
    test_mask_and_leak_thresholds();
    test_clamp();
    test_formatting();
    test_wrap_day_index();
    test_cooldown();
    test_next_daily_wakeup();
    test_double_tap();

    printf("%d checks, %d failed\n", s_checks, s_failures);
    return s_failures == 0 ? 0 : 1;
}
