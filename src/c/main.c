/**
 * ResMed CPAP Stats — Pebble Watch App
 *
 * Displays ResMed myAir CPAP therapy stats (sleep score, AHI, usage, etc.)
 * for the past 7 nights. Data is fetched from the ResMed myAir API via the
 * phone companion (PebbleKit JS) and sent over AppMessage.
 *
 * Controls:
 *   UP/DOWN  — Cycle through days (most recent first)
 *   SELECT   — Manually refresh data from myAir
 *   BACK     — Exit app
 *
 * Data refreshes on launch when the cache is stale, plus once a day via a
 * morning Wakeup. A wakeup launch fetches in the background of the UI and
 * then exits back to the watchface on its own.
 */

#include <pebble.h>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of days of sleep data to store and display. */
#define MAX_DAYS 7

/** Wakeup reason identifier (unused, but required by the API). */
#define WAKEUP_REASON_REFRESH 0

/** Local hour of the daily background refresh (after the night's data syncs). */
#define WAKEUP_HOUR 9

/** Skip the wakeup fetch if data was synced this recently. */
#define WAKEUP_FRESH_SECS (60 * 60)

/** Give up and exit a wakeup launch if no data arrives in this time. */
#define WAKEUP_TIMEOUT_MS (60 * 1000)

/** Linger on the result briefly before exiting a wakeup launch. */
#define WAKEUP_EXIT_DELAY_MS 1500

/**
 * Minimum seconds between manual syncs (SELECT button).
 * Prevents spamming the ResMed API. Users can still view cached data
 * freely — only the API call is rate-limited.
 */
#define MANUAL_SYNC_COOLDOWN_SECS (15 * 60)  // 15 minutes

/** Interval between loading animation dot updates (milliseconds). */
#define LOADING_ANIMATION_MS 500

/** Maximum number of loading dots before cycling back to 1. */
#define LOADING_DOTS_COUNT 3

/** AppMessage retry delay when a send fails (milliseconds). */
#define APPMESSAGE_RETRY_DELAY_MS 200

// -- Persistent Storage Keys --

/** Key for storing the sleep records array in watch flash. */
#define PERSIST_KEY_RECORDS  1

/** Key for storing the total number of days with data. */
#define PERSIST_KEY_TOTAL    2

/** Key for storing the last sync timestamp string. */
#define PERSIST_KEY_SYNC     3

/** Key for storing colorblind mode setting (0=off, 1=on). */
#define PERSIST_KEY_COLORBLIND 4

/** Key for storing sync interval in hours. */
#define PERSIST_KEY_SYNC_INTERVAL 5

/**
 * Key for storing visible stats as a bitmask (single integer).
 * Each bit represents one stat: bit 0 = Events, bit 1 = Usage,
 * bit 2 = Mask Off, bit 3 = Leak. A set bit means the stat is shown.
 * This is more efficient than a list for a fixed set of 4 items —
 * one persist read/write, no dynamic memory, and the visible count
 * is derived by summing the flags via get_visible_stat_count().
 * If the count is 0, the score takes up the full display.
 */
#define PERSIST_KEY_VISIBLE_STATS 6

/** Key for storing the last sync epoch (unix timestamp). */
#define PERSIST_KEY_SYNC_EPOCH 7

/** Key for storing the text indicators setting (0=off, 1=on). */
#define PERSIST_KEY_TEXT_INDICATORS 8

// -- AppMessage Buffer Sizes --

/** Inbox buffer size — must fit one day's data (~70 bytes) with headroom. */
#define APPMESSAGE_INBOX_SIZE  256

/** Outbox buffer size — only sends REQUEST_DATA (very small). */
#define APPMESSAGE_OUTBOX_SIZE 64

/** Give up waiting for the phone after this long (covers its retries). */
#define LOADING_TIMEOUT_MS (120 * 1000)

/** Delay and attempt cap for resending REQUEST_DATA the phone NACKed. */
#define REQUEST_RETRY_DELAY_MS 1000
#define REQUEST_MAX_ATTEMPTS 10

// -- UI Layout --
// All positions are computed proportionally from screen bounds in draw
// functions — no hardcoded pixel positions. This ensures the layout
// works on all screen sizes from aplite (144x168) to emery (200x228).

/** Maximum length of the error message buffer. */
#define ERROR_MSG_MAX_LEN 64

/** Maximum length of the sync time display string. */
#define SYNC_TIME_MAX_LEN 16

// -- Color Palette --
// Uses PBL_IF_COLOR_ELSE for B&W fallback on aplite/diorite.

#define COLOR_HEADER_BG   PBL_IF_COLOR_ELSE(GColorOxfordBlue, GColorBlack)
#define COLOR_HEADER_TEXT  GColorWhite
#define COLOR_CARD_BG      PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack)
#define COLOR_CARD_BORDER  PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite)
#define COLOR_LABEL        PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite)
#define COLOR_VALUE        GColorWhite
#define COLOR_HINT         PBL_IF_COLOR_ELSE(GColorDarkGray, GColorWhite)
#define COLOR_BACKGROUND   GColorBlack
#define COLOR_SCORE_GOOD   PBL_IF_COLOR_ELSE(GColorGreen, GColorWhite)
#define COLOR_SCORE_OK     PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorWhite)
#define COLOR_SCORE_BAD    PBL_IF_COLOR_ELSE(GColorRed, GColorWhite)
#define COLOR_LOADING      PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite)

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

// ---------------------------------------------------------------------------
// Data Structures
// ---------------------------------------------------------------------------

/** A single night's CPAP sleep therapy record. */
typedef struct {
    char date[16];           // Display date string, e.g. "Apr 14"
    int16_t sleep_score;     // myAir composite score (0-100)
    int16_t ahi_x10;         // Apnea-Hypopnea Index × 10 (avoids floats)
    int16_t usage_mins;      // Total mask-on time in minutes
    int16_t mask_count;      // Number of mask on/off events
    int16_t leak_pct;        // Mask leak percentile (0-100)
    bool has_data;           // Whether this record slot has been populated
} SleepRecord;

/** Possible states for the app's main display. */
typedef enum {
    STATE_LOADING,           // Waiting for data from phone
    STATE_CONNECTED,         // Login succeeded, data incoming — shown briefly
    STATE_DISPLAY,           // Showing sleep records
    STATE_ERROR,             // Showing an error message
    STATE_NO_CONFIG          // No myAir credentials configured yet
} AppState;

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------

// -- UI --
static Window *s_main_window;
static Layer *s_canvas_layer;

// -- Sleep Data --
static SleepRecord s_records[MAX_DAYS];  // Cached sleep records (most recent first)
static int s_total_days = 0;             // Number of records with data
static int s_current_day_index = 0;      // Currently displayed day (0 = most recent)

// -- App State --
static AppState s_app_state = STATE_LOADING;
static char s_error_message[ERROR_MSG_MAX_LEN];
static bool s_error_is_cooldown = false;      // Error screen is the manual-sync cooldown
static char s_last_sync_time[SYNC_TIME_MAX_LEN];

// -- Loading Animation --
static int s_loading_dot_count = 0;      // Current number of dots (0-2)
static AppTimer *s_loading_anim_timer = NULL;
static AppTimer *s_loading_timeout_timer = NULL;
static AppTimer *s_request_retry_timer = NULL;
static int s_request_attempts = 0;
static bool s_sync_failed = false;       // Last refresh failed; cached data still shown

// -- Settings --
static bool s_colorblind_mode = false;         // Swap color palette for colorblind users
static bool s_text_indicators = false;         // Replace values with "Good"/"OK"/"Poor" text
static int s_sync_interval_hours = 4;          // Hours before cached data is refreshed on open

// Stat visibility flags (all default to visible)
static bool s_show_events = true;
static bool s_show_usage = true;
static bool s_show_mask_off = true;
static bool s_show_leak = true;

// -- Sync Timing --
static bool s_launched_by_wakeup = false;
static AppTimer *s_wakeup_exit_timer = NULL;
static time_t s_last_sync_epoch = 0;           // Unix timestamp of last successful sync

// ---------------------------------------------------------------------------
// Utility — Bounds clamping for safe int32 → int16_t conversion (Finding #13)
// ---------------------------------------------------------------------------

/** Clamp a 32-bit value to a valid int16_t range. */
static int16_t clamp_int16(int32_t value, int16_t min_val, int16_t max_val) {
    if (value < min_val) return min_val;
    if (value > max_val) return max_val;
    return (int16_t)value;
}

// ---------------------------------------------------------------------------
// Color Helpers — Map clinical values to color-coded indicators
// ---------------------------------------------------------------------------

/** Returns color-coded indicator for the myAir sleep score. */
static GColor get_score_color(int score) {
    if (s_colorblind_mode) return COLOR_VALUE;
    if (score >= SCORE_GOOD_THRESHOLD) return COLOR_SCORE_GOOD;
    if (score >= SCORE_OK_THRESHOLD) return COLOR_SCORE_OK;
    return COLOR_SCORE_BAD;
}

/** Returns color-coded indicator for the AHI value (×10). */
static GColor get_ahi_color(int ahi_x10) {
    if (s_colorblind_mode) return COLOR_VALUE;
    if (ahi_x10 < AHI_NORMAL_THRESHOLD_X10) return COLOR_SCORE_GOOD;
    if (ahi_x10 < AHI_MILD_THRESHOLD_X10) return COLOR_SCORE_OK;
    return COLOR_SCORE_BAD;
}

/** Returns color-coded indicator for CPAP usage duration. */
static GColor get_usage_color(int usage_mins) {
    if (s_colorblind_mode) return COLOR_VALUE;
    if (usage_mins >= USAGE_GOOD_THRESHOLD_MINS) return COLOR_SCORE_GOOD;
    if (usage_mins >= USAGE_OK_THRESHOLD_MINS) return COLOR_SCORE_OK;
    return COLOR_SCORE_BAD;
}

// ---------------------------------------------------------------------------
// Persistent Storage — Cache records to watch flash for instant display
// ---------------------------------------------------------------------------

/** Save current records, day count, and sync time to persistent storage. */
static void persist_save_records(void) {
    persist_write_data(PERSIST_KEY_RECORDS, s_records, sizeof(s_records));
    persist_write_int(PERSIST_KEY_TOTAL, s_total_days);
    persist_write_string(PERSIST_KEY_SYNC, s_last_sync_time);
}

/** Load cached records and settings from persistent storage. */
static void persist_load_records(void) {
    if (persist_exists(PERSIST_KEY_RECORDS)) {
        persist_read_data(PERSIST_KEY_RECORDS, s_records, sizeof(s_records));
        s_total_days = persist_read_int(PERSIST_KEY_TOTAL);
        persist_read_string(PERSIST_KEY_SYNC, s_last_sync_time, sizeof(s_last_sync_time));
        if (s_total_days > 0) {
            s_app_state = STATE_DISPLAY;
        }
    }
    if (persist_exists(PERSIST_KEY_COLORBLIND)) {
        s_colorblind_mode = persist_read_bool(PERSIST_KEY_COLORBLIND);
    }
    if (persist_exists(PERSIST_KEY_TEXT_INDICATORS)) {
        s_text_indicators = persist_read_bool(PERSIST_KEY_TEXT_INDICATORS);
    }
    if (persist_exists(PERSIST_KEY_SYNC_INTERVAL)) {
        s_sync_interval_hours = persist_read_int(PERSIST_KEY_SYNC_INTERVAL);
        if (s_sync_interval_hours < 4) s_sync_interval_hours = 4;
    }
    if (persist_exists(PERSIST_KEY_SYNC_EPOCH)) {
        s_last_sync_epoch = (time_t)persist_read_int(PERSIST_KEY_SYNC_EPOCH);
    }
    if (persist_exists(PERSIST_KEY_VISIBLE_STATS)) {
        // Bitmask: bit 0=events, 1=usage, 2=mask_off, 3=leak
        int mask = persist_read_int(PERSIST_KEY_VISIBLE_STATS);
        s_show_events  = (mask & 1) != 0;
        s_show_usage   = (mask & 2) != 0;
        s_show_mask_off = (mask & 4) != 0;
        s_show_leak    = (mask & 8) != 0;
    }
}

// ---------------------------------------------------------------------------
// Wakeup — Schedule periodic background data refreshes
// ---------------------------------------------------------------------------

/**
 * Schedule the next daily refresh at WAKEUP_HOUR local time.
 *
 * Cancels every existing wakeup first: older builds scheduled a new wakeup
 * on each launch without cancelling the previous one, so they piled up.
 */
static void schedule_next_wakeup(void) {
    wakeup_cancel_all();

    time_t now = time(NULL);
    struct tm *local_time = localtime(&now);
    local_time->tm_hour = WAKEUP_HOUR;
    local_time->tm_min = 0;
    local_time->tm_sec = 0;
    time_t next_wakeup_time = mktime(local_time);
    if (next_wakeup_time <= now + 60) {
        next_wakeup_time += 24 * 3600;
    }

    // Another app may hold a wakeup within a minute of ours; nudge later
    for (int attempt = 0; attempt < 5; attempt++) {
        WakeupId id = wakeup_schedule(next_wakeup_time + attempt * 120,
                                      WAKEUP_REASON_REFRESH, false);
        if (id != E_RANGE) {
            if (id < 0) {
                APP_LOG(APP_LOG_LEVEL_ERROR, "wakeup_schedule failed: %d", (int)id);
            }
            return;
        }
    }
}

/** Exit to the watchface, ending a wakeup launch. */
static void wakeup_exit_callback(void *data) {
    s_wakeup_exit_timer = NULL;
    window_stack_pop_all(true);
}

/** If this is an unattended wakeup launch, exit after `delay_ms`. */
static void schedule_wakeup_exit(uint32_t delay_ms) {
    if (!s_launched_by_wakeup) return;
    if (s_wakeup_exit_timer) {
        app_timer_cancel(s_wakeup_exit_timer);
    }
    s_wakeup_exit_timer = app_timer_register(delay_ms, wakeup_exit_callback, NULL);
}

/** The user is interacting, so keep the app open after all. */
static void cancel_wakeup_exit(void) {
    s_launched_by_wakeup = false;
    if (s_wakeup_exit_timer) {
        app_timer_cancel(s_wakeup_exit_timer);
        s_wakeup_exit_timer = NULL;
    }
}

// ---------------------------------------------------------------------------
// AppMessage — Request data from the phone companion
// ---------------------------------------------------------------------------

/** Send a REQUEST_DATA message to the phone to trigger a data fetch. */
static void send_data_request(void) {
    s_request_attempts++;
    DictionaryIterator *outbox;
    AppMessageResult result = app_message_outbox_begin(&outbox);
    if (result == APP_MSG_OK) {
        dict_write_uint8(outbox, MESSAGE_KEY_REQUEST_DATA, 1);
        // Tell the phone whether this is a fresh install (no cached data).
        // If fresh, the phone should clear any stale credentials from a
        // previous install since PebbleKit JS localStorage persists across
        // app uninstall/reinstall but watch persistent storage does not.
        if (!persist_exists(PERSIST_KEY_RECORDS)) {
            dict_write_uint8(outbox, MESSAGE_KEY_FRESH_INSTALL, 1);
        }
        app_message_outbox_send();
    }
}

// ---------------------------------------------------------------------------
// Drawing — Render the UI based on current app state
// ---------------------------------------------------------------------------
// All positions are computed from screen bounds so the layout adapts
// to any Pebble screen size (144x168 through 200x228).

// -- Text indicators --
// When enabled, these REPLACE numeric values with human-readable
// interpretations like "Good", "OK", "Poor" — for users who don't
// care about the exact numbers.

static const char* get_score_text(int score) {
    if (score >= SCORE_GOOD_THRESHOLD) return "Good";
    if (score >= SCORE_OK_THRESHOLD) return "OK";
    return "Poor";
}

static const char* get_ahi_text(int ahi_x10) {
    if (ahi_x10 < AHI_NORMAL_THRESHOLD_X10) return "Good";
    if (ahi_x10 < AHI_MILD_THRESHOLD_X10) return "Mild";
    return "High";
}

static const char* get_usage_text(int usage_mins) {
    if (usage_mins >= USAGE_GOOD_THRESHOLD_MINS) return "Good";
    if (usage_mins >= USAGE_OK_THRESHOLD_MINS) return "OK";
    return "Low";
}

static const char* get_mask_text(int mask_count) {
    if (mask_count < MASK_GOOD_THRESHOLD) return "Good";
    if (mask_count < MASK_OK_THRESHOLD) return "OK";
    return "High";
}

static const char* get_leak_text(int leak_pct) {
    if (leak_pct < LEAK_GOOD_THRESHOLD) return "Good";
    if (leak_pct < LEAK_OK_THRESHOLD) return "OK";
    return "High";
}

/** Draw the header bar with date and day counter. */
static void draw_header(GContext *ctx, GRect bounds, SleepRecord *record) {
    int W = bounds.size.w;
    int H = bounds.size.h;
    int header_h = H * 13 / 100;  // ~13% of screen height

    graphics_context_set_fill_color(ctx, COLOR_HEADER_BG);
    graphics_fill_rect(ctx, GRect(0, 0, W, header_h), 0, GCornerNone);

    graphics_context_set_text_color(ctx, COLOR_HEADER_TEXT);

    if (record && record->has_data) {
        // Show date on left
        graphics_draw_text(ctx, record->date,
            fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(4, 0, W / 2, header_h),
            GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

        // Show day counter on right (e.g. "2/7")
        if (s_total_days > 1) {
            static char day_counter[24];
            snprintf(day_counter, sizeof(day_counter), "%d/%d",
                     s_current_day_index + 1, s_total_days);
            graphics_draw_text(ctx, day_counter,
                fonts_get_system_font(FONT_KEY_GOTHIC_18),
                GRect(W / 2, 0, W / 2 - 4, header_h),
                GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
        }
    } else {
        graphics_draw_text(ctx, "ResMed Stats",
            fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
            GRect(4, 0, W - 8, header_h),
            GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    }
}

/** Count how many stat rows are currently enabled. */
static int get_visible_stat_count(void) {
    int count = 0;
    if (s_show_events) count++;
    if (s_show_usage) count++;
    if (s_show_mask_off) count++;
    if (s_show_leak) count++;
    return count;
}

/** Draw the large centered myAir score as the hero element. */
static void draw_score_hero(GContext *ctx, GRect bounds, SleepRecord *record) {
    int W = bounds.size.w;
    int H = bounds.size.h;

    if (!record || !record->has_data) return;

    bool full_view = (get_visible_stat_count() == 0);

    // Score number — larger and centered when no stats are shown
    static char score_num[8];
    snprintf(score_num, sizeof(score_num), "%d", record->sleep_score);

    int score_y, score_font_h;
    GFont score_font;

    if (full_view) {
        // Full view: big score centered vertically
        score_font = fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD);
        score_font_h = 48;
        score_y = H / 2 - 36;
    } else {
        // Normal view: score in upper portion
        score_font = fonts_get_system_font(FONT_KEY_LECO_36_BOLD_NUMBERS);
        score_font_h = 40;
        score_y = H * 15 / 100;
    }

    graphics_context_set_text_color(ctx, get_score_color(record->sleep_score));
    graphics_draw_text(ctx, score_num, score_font,
        GRect(0, score_y, W, score_font_h),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    // Score label — show "myAir Score" or the text interpretation
    const char *score_label = s_text_indicators ?
        get_score_text(record->sleep_score) : "myAir Score";

    int label_y = full_view ? score_y + score_font_h : score_y + 38;

    graphics_context_set_text_color(ctx, COLOR_LABEL);
    graphics_draw_text(ctx, score_label,
        fonts_get_system_font(full_view ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14),
        GRect(0, label_y, W, 20),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

/**
 * Draw a compact stat row: label on left, value on right.
 * Uses GOTHIC_14 to fit on small screens.
 */
static void draw_stat_row(GContext *ctx, int y, int W,
                           const char *label, const char *value, GColor val_color) {
    int pad = 6;
    int label_w = W / 2 - pad;
    int value_w = W / 2 - pad;

    graphics_context_set_text_color(ctx, COLOR_LABEL);
    graphics_draw_text(ctx, label,
        fonts_get_system_font(FONT_KEY_GOTHIC_18),
        GRect(pad, y, label_w, 20),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

    graphics_context_set_text_color(ctx, val_color);
    graphics_draw_text(ctx, value,
        fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
        GRect(W / 2, y, value_w, 20),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

/** Draw the stats section — only renders user-selected stats. */
static void draw_stats(GContext *ctx, GRect bounds, SleepRecord *record) {
    if (!record || !record->has_data) return;

    int W = bounds.size.w;
    int H = bounds.size.h;
    int footer_h = 18;

    int visible_count = get_visible_stat_count();
    if (visible_count == 0) return;

    int stats_top = H * 51 / 100;
    int stats_bottom = H - footer_h - 2;
    int row_h = (stats_bottom - stats_top) / visible_count;

    // Divider line
    graphics_context_set_stroke_color(ctx, COLOR_CARD_BORDER);
    graphics_draw_line(ctx, GPoint(6, stats_top - 3), GPoint(W - 6, stats_top - 3));

    // Format values — text indicators replace numbers when enabled
    static char ahi_text[16];
    static char usage_text[12];
    static char mask_text[8];
    static char leak_text[8];

    if (s_text_indicators) {
        snprintf(ahi_text, sizeof(ahi_text), "%s", get_ahi_text(record->ahi_x10));
        snprintf(usage_text, sizeof(usage_text), "%s", get_usage_text(record->usage_mins));
        snprintf(mask_text, sizeof(mask_text), "%s", get_mask_text(record->mask_count));
        snprintf(leak_text, sizeof(leak_text), "%s", get_leak_text(record->leak_pct));
    } else {
        snprintf(ahi_text, sizeof(ahi_text), "%d.%d /hr",
                 record->ahi_x10 / 10, record->ahi_x10 % 10);
        snprintf(usage_text, sizeof(usage_text), "%dh %02dm",
                 record->usage_mins / 60, record->usage_mins % 60);
        snprintf(mask_text, sizeof(mask_text), "%d", record->mask_count);
        snprintf(leak_text, sizeof(leak_text), "%d%%", record->leak_pct);
    }

    // Draw only user-selected stats, stacked dynamically
    int row = 0;
    if (s_show_events) {
        draw_stat_row(ctx, stats_top + row_h * row, W,
                      "Events", ahi_text, get_ahi_color(record->ahi_x10));
        row++;
    }
    if (s_show_usage) {
        draw_stat_row(ctx, stats_top + row_h * row, W,
                      "Usage", usage_text, get_usage_color(record->usage_mins));
        row++;
    }
    if (s_show_mask_off) {
        draw_stat_row(ctx, stats_top + row_h * row, W,
                      "Mask Off", mask_text, COLOR_VALUE);
        row++;
    }
    if (s_show_leak) {
        draw_stat_row(ctx, stats_top + row_h * row, W,
                      "Leak", leak_text, COLOR_VALUE);
        row++;
    }
}

/** Draw the footer with sync info. */
static void draw_footer(GContext *ctx, GRect bounds) {
    int W = bounds.size.w;
    int H = bounds.size.h;

    const char *footer_text;
    static char sync_buf[40];

    if (s_sync_failed) {
        footer_text = "Sync failed. SELECT to retry";
    } else if (s_last_sync_epoch != 0) {
        // Include the date when the last sync wasn't today, so stale data
        // doesn't look fresh
        time_t now = time(NULL);
        struct tm *now_tm = localtime(&now);
        int today_yday = now_tm->tm_yday;
        int today_year = now_tm->tm_year;
        struct tm *sync_tm = localtime(&s_last_sync_epoch);
        if (sync_tm->tm_yday == today_yday && sync_tm->tm_year == today_year) {
            snprintf(sync_buf, sizeof(sync_buf), "Synced %s", s_last_sync_time);
        } else {
            char month_buf[8];
            strftime(month_buf, sizeof(month_buf), "%b", sync_tm);
            snprintf(sync_buf, sizeof(sync_buf), "Synced %s %d", month_buf, sync_tm->tm_mday);
        }
        footer_text = sync_buf;
    } else if (s_last_sync_time[0] != '\0') {
        snprintf(sync_buf, sizeof(sync_buf), "Synced %s", s_last_sync_time);
        footer_text = sync_buf;
    } else {
        footer_text = "SELECT to sync";
    }

    graphics_context_set_text_color(ctx, COLOR_HINT);
    graphics_draw_text(ctx, footer_text,
        fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(0, H - 16, W, 14),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

/** Draw the loading screen with animated dots. */
static void draw_loading_screen(GContext *ctx, GRect bounds) {
    static char loading_text[20];
    snprintf(loading_text, sizeof(loading_text), "Loading%.*s",
             s_loading_dot_count + 1, "...");

    graphics_context_set_text_color(ctx, COLOR_LOADING);
    graphics_draw_text(ctx, loading_text,
        fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
        GRect(0, bounds.size.h / 2 - 16, bounds.size.w, 30),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

/** Draw the error screen with the error message and a retry hint. */
static void draw_error_screen(GContext *ctx, GRect bounds) {
    int margin = 8;
    graphics_context_set_text_color(ctx, COLOR_SCORE_BAD);
    graphics_draw_text(ctx, s_error_message,
        fonts_get_system_font(FONT_KEY_GOTHIC_18),
        GRect(margin, bounds.size.h / 2 - 30, bounds.size.w - margin * 2, 60),
        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);

    graphics_context_set_text_color(ctx, COLOR_HINT);
    // During the cooldown a short press only repeats this message, so
    // point at the long press that bypasses it
    const char *hint = s_error_is_cooldown ? "Hold SELECT to force sync"
                                           : "SELECT to retry";
    graphics_draw_text(ctx, hint,
        fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(0, bounds.size.h / 2 + 30, bounds.size.w, 18),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

/** Draw the "Connected!" confirmation screen shown briefly after login. */
static void draw_connected_screen(GContext *ctx, GRect bounds) {
    graphics_context_set_text_color(ctx, COLOR_SCORE_GOOD);
    graphics_draw_text(ctx, "Connected\nto myAir!",
        fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
        GRect(8, bounds.size.h / 2 - 40, bounds.size.w - 16, 50),
        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);

    graphics_context_set_text_color(ctx, COLOR_LABEL);
    graphics_draw_text(ctx, "Loading sleep data...",
        fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(8, bounds.size.h / 2 + 16, bounds.size.w - 16, 20),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

/** Draw the "no credentials" screen prompting the user to set up on phone. */
static void draw_setup_prompt_screen(GContext *ctx, GRect bounds) {
    int margin = 8;
    graphics_context_set_text_color(ctx, COLOR_VALUE);
    graphics_draw_text(ctx,
        "Open the app on your phone to connect your ResMed account",
        fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
        GRect(margin, bounds.size.h / 2 - 45, bounds.size.w - margin * 2, 90),
        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

/** Main canvas update proc — dispatches to the appropriate draw function. */
static void canvas_update_proc(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);

    // Clear background
    graphics_context_set_fill_color(ctx, COLOR_BACKGROUND);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    switch (s_app_state) {
        case STATE_LOADING:
            draw_header(ctx, bounds, NULL);
            draw_loading_screen(ctx, bounds);
            break;

        case STATE_CONNECTED:
            draw_header(ctx, bounds, NULL);
            draw_connected_screen(ctx, bounds);
            break;

        case STATE_DISPLAY: {
            SleepRecord *current_record =
                (s_current_day_index < s_total_days) ? &s_records[s_current_day_index] : NULL;
            draw_header(ctx, bounds, current_record);
            draw_score_hero(ctx, bounds, current_record);
            draw_stats(ctx, bounds, current_record);
            draw_footer(ctx, bounds);
            break;
        }

        case STATE_ERROR:
            draw_header(ctx, bounds, NULL);
            draw_error_screen(ctx, bounds);
            break;

        case STATE_NO_CONFIG:
            draw_header(ctx, bounds, NULL);
            draw_setup_prompt_screen(ctx, bounds);
            break;
    }
}

// ---------------------------------------------------------------------------
// Loading Animation
// ---------------------------------------------------------------------------

/** Timer callback that advances the loading dots and reschedules. */
static void loading_animation_tick(void *data) {
    s_loading_dot_count = (s_loading_dot_count + 1) % LOADING_DOTS_COUNT;
    layer_mark_dirty(s_canvas_layer);
    if (s_app_state == STATE_LOADING) {
        s_loading_anim_timer = app_timer_register(LOADING_ANIMATION_MS,
                                                   loading_animation_tick, NULL);
    }
}

/** Forward declaration — defined with the AppMessage callbacks. */
static void loading_timeout_callback(void *data);

/** Enter the loading state and start the dot animation. */
static void enter_loading_state(void) {
    s_app_state = STATE_LOADING;
    s_sync_failed = false;
    s_request_attempts = 0;
    if (s_loading_timeout_timer) {
        app_timer_cancel(s_loading_timeout_timer);
    }
    s_loading_timeout_timer = app_timer_register(LOADING_TIMEOUT_MS,
                                                  loading_timeout_callback, NULL);
    s_loading_dot_count = 0;
    layer_mark_dirty(s_canvas_layer);
    if (s_loading_anim_timer) {
        app_timer_cancel(s_loading_anim_timer);
    }
    s_loading_anim_timer = app_timer_register(LOADING_ANIMATION_MS,
                                               loading_animation_tick, NULL);
}

/** Stop the loading animation and the timeout/retry timers. */
static void stop_loading_animation(void) {
    if (s_loading_anim_timer) {
        app_timer_cancel(s_loading_anim_timer);
        s_loading_anim_timer = NULL;
    }
    if (s_loading_timeout_timer) {
        app_timer_cancel(s_loading_timeout_timer);
        s_loading_timeout_timer = NULL;
    }
    if (s_request_retry_timer) {
        app_timer_cancel(s_request_retry_timer);
        s_request_retry_timer = NULL;
    }
}

// ---------------------------------------------------------------------------
// Button Handlers
// ---------------------------------------------------------------------------

/** UP button: navigate to the previous day's record. */
static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
    cancel_wakeup_exit();
    if (s_app_state == STATE_ERROR && s_total_days > 0) {
        // Dismiss the error and go back to the cached data
        s_app_state = STATE_DISPLAY;
        layer_mark_dirty(s_canvas_layer);
        return;
    }
    if (s_app_state != STATE_DISPLAY || s_total_days == 0) return;
    s_current_day_index = (s_current_day_index - 1 + s_total_days) % s_total_days;
    layer_mark_dirty(s_canvas_layer);
}

/** DOWN button: navigate to the next day's record. */
static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
    cancel_wakeup_exit();
    if (s_app_state == STATE_ERROR && s_total_days > 0) {
        s_app_state = STATE_DISPLAY;
        layer_mark_dirty(s_canvas_layer);
        return;
    }
    if (s_app_state != STATE_DISPLAY || s_total_days == 0) return;
    s_current_day_index = (s_current_day_index + 1) % s_total_days;
    layer_mark_dirty(s_canvas_layer);
}

/**
 * SELECT button: manually trigger a data refresh from myAir.
 * Rate-limited to prevent spamming the API — CPAP data only changes
 * once per night, so frequent refreshes aren't useful.
 */
static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
    cancel_wakeup_exit();
    // If not configured, do nothing — user needs to log in on phone
    if (s_app_state == STATE_NO_CONFIG) {
        return;
    }

    // If already loading, ignore additional presses
    if (s_app_state == STATE_LOADING || s_app_state == STATE_CONNECTED) {
        return;
    }

    // Rate-limit manual syncs to avoid spamming the API
    if (s_last_sync_epoch > 0) {
        time_t seconds_since_sync = time(NULL) - s_last_sync_epoch;
        if (seconds_since_sync < MANUAL_SYNC_COOLDOWN_SECS) {
            int mins_remaining = (MANUAL_SYNC_COOLDOWN_SECS - seconds_since_sync) / 60 + 1;
            snprintf(s_error_message, sizeof(s_error_message),
                     "Synced recently.\nRetry in %d min.", mins_remaining);
            s_error_is_cooldown = true;
            s_app_state = STATE_ERROR;
            layer_mark_dirty(s_canvas_layer);
            return;
        }
    }

    enter_loading_state();
    send_data_request();
}

/** Long-press SELECT (3 seconds): force sync, bypassing cooldown. */
static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
    cancel_wakeup_exit();
    if (s_app_state == STATE_NO_CONFIG) return;
    if (s_app_state == STATE_LOADING || s_app_state == STATE_CONNECTED) return;

    // Force sync — skip cooldown check
    enter_loading_state();
    send_data_request();
}

/** Register button click handlers for UP, DOWN, and SELECT. */
static void click_config_provider(void *context) {
    window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
    window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
    window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
    window_long_click_subscribe(BUTTON_ID_SELECT, 3000, select_long_click_handler, NULL);
}

// ---------------------------------------------------------------------------
// AppMessage Callbacks — Handle incoming data from phone companion
// ---------------------------------------------------------------------------

/**
 * Handle incoming messages from the phone companion.
 *
 * Message types (determined by which keys are present):
 *   ERROR_MSG    — Display an error or the setup prompt screen
 *   TOTAL_DAYS   — Start of a new data sequence; clear existing records
 *   DAY_INDEX    — One day's sleep record data
 *   DATA_COMPLETE — All days sent; switch to display state
 */
static void inbox_received_handler(DictionaryIterator *iterator, void *context) {
    // -- Error messages --
    Tuple *error_tuple = dict_find(iterator, MESSAGE_KEY_ERROR_MSG);
    if (error_tuple) {
        stop_loading_animation();

        // Show the friendly setup screen for credential-related errors
        if (strstr(error_tuple->value->cstring, "Settings") != NULL ||
            strstr(error_tuple->value->cstring, "log in") != NULL) {
            s_app_state = STATE_NO_CONFIG;
            s_last_sync_epoch = 0;
            // Clear cached medical data from watch storage (Finding #12)
            s_total_days = 0;
            memset(s_records, 0, sizeof(s_records));
            s_last_sync_time[0] = '\0';
            persist_delete(PERSIST_KEY_RECORDS);
            persist_delete(PERSIST_KEY_TOTAL);
            persist_delete(PERSIST_KEY_SYNC);
            persist_delete(PERSIST_KEY_SYNC_EPOCH);
        } else {
            snprintf(s_error_message, sizeof(s_error_message), "%s",
                     error_tuple->value->cstring);
            s_error_is_cooldown = false;
            if (s_total_days > 0) {
                // Keep showing the cached data; the footer notes the failure
                s_sync_failed = true;
                s_app_state = STATE_DISPLAY;
            } else {
                s_app_state = STATE_ERROR;
            }
            // Brief vibration to alert user since the phone has no error UI,
            // but stay quiet during an unattended wakeup refresh.
            // Custom pattern: 100ms buzz (shorter than vibes_short_pulse's 200ms)
            if (!s_launched_by_wakeup) {
                static const uint32_t error_vibe[] = { 100 };
                VibePattern pat = { .durations = error_vibe, .num_segments = 1 };
                vibes_enqueue_custom_pattern(pat);
            }
        }
        layer_mark_dirty(s_canvas_layer);
        schedule_wakeup_exit(WAKEUP_EXIT_DELAY_MS);
        return;
    }

    // -- Settings update from phone --
    Tuple *colorblind_tuple = dict_find(iterator, MESSAGE_KEY_COLORBLIND_MODE);
    Tuple *sync_int_tuple = dict_find(iterator, MESSAGE_KEY_SYNC_INTERVAL);
    Tuple *show_events_tuple = dict_find(iterator, MESSAGE_KEY_SHOW_EVENTS);
    if (colorblind_tuple || sync_int_tuple || show_events_tuple) {
        if (colorblind_tuple) {
            s_colorblind_mode = (colorblind_tuple->value->int32 == 1);
            persist_write_bool(PERSIST_KEY_COLORBLIND, s_colorblind_mode);
        }
        Tuple *text_ind_tuple = dict_find(iterator, MESSAGE_KEY_TEXT_INDICATORS);
        if (text_ind_tuple) {
            s_text_indicators = (text_ind_tuple->value->int32 == 1);
            persist_write_bool(PERSIST_KEY_TEXT_INDICATORS, s_text_indicators);
        }
        if (sync_int_tuple) {
            s_sync_interval_hours = (int)sync_int_tuple->value->int32;
            if (s_sync_interval_hours < 4) s_sync_interval_hours = 4;
            persist_write_int(PERSIST_KEY_SYNC_INTERVAL, s_sync_interval_hours);
        }

        // Stat visibility flags
        if (show_events_tuple) {
            s_show_events = (show_events_tuple->value->int32 == 1);
        }
        Tuple *show_usage_tuple = dict_find(iterator, MESSAGE_KEY_SHOW_USAGE);
        if (show_usage_tuple) {
            s_show_usage = (show_usage_tuple->value->int32 == 1);
        }
        Tuple *show_mask_tuple = dict_find(iterator, MESSAGE_KEY_SHOW_MASK_OFF);
        if (show_mask_tuple) {
            s_show_mask_off = (show_mask_tuple->value->int32 == 1);
        }
        Tuple *show_leak_tuple = dict_find(iterator, MESSAGE_KEY_SHOW_LEAK);
        if (show_leak_tuple) {
            s_show_leak = (show_leak_tuple->value->int32 == 1);
        }

        // Save stat visibility as bitmask
        int mask = (s_show_events ? 1 : 0) | (s_show_usage ? 2 : 0) |
                   (s_show_mask_off ? 4 : 0) | (s_show_leak ? 8 : 0);
        persist_write_int(PERSIST_KEY_VISIBLE_STATS, mask);

        layer_mark_dirty(s_canvas_layer);
        return;
    }

    // -- Total days (first message in a data sequence) --
    // This message confirms that authentication succeeded and data was found.
    Tuple *total_days_tuple = dict_find(iterator, MESSAGE_KEY_TOTAL_DAYS);
    if (total_days_tuple && !dict_find(iterator, MESSAGE_KEY_DAY_INDEX)) {
        // Leave the loading timeout running in case the sequence stalls
        s_total_days = (int)total_days_tuple->value->int32;
        s_current_day_index = 0;
        memset(s_records, 0, sizeof(s_records));

        // Clear the sync cooldown so fresh logins sync immediately
        s_last_sync_epoch = 0;

        // Show the "Connected!" confirmation only on first login; a routine
        // refresh stays on the loading screen until DATA_COMPLETE
        if (!persist_exists(PERSIST_KEY_RECORDS)) {
            s_app_state = STATE_CONNECTED;
            layer_mark_dirty(s_canvas_layer);
        }
        return;
    }

    // -- Individual day record --
    Tuple *day_index_tuple = dict_find(iterator, MESSAGE_KEY_DAY_INDEX);
    if (day_index_tuple) {
        int day_index = (int)day_index_tuple->value->int32;
        if (day_index >= 0 && day_index < MAX_DAYS) {
            SleepRecord *record = &s_records[day_index];
            Tuple *tuple;

            tuple = dict_find(iterator, MESSAGE_KEY_RECORD_DATE);
            if (tuple) {
                snprintf(record->date, sizeof(record->date), "%s",
                         tuple->value->cstring);
            }

            // Clamp values to valid ranges to prevent int16_t truncation (Finding #13)
            tuple = dict_find(iterator, MESSAGE_KEY_SLEEP_SCORE);
            if (tuple) record->sleep_score = clamp_int16(tuple->value->int32, 0, 100);

            tuple = dict_find(iterator, MESSAGE_KEY_AHI_X10);
            if (tuple) record->ahi_x10 = clamp_int16(tuple->value->int32, 0, 9999);

            tuple = dict_find(iterator, MESSAGE_KEY_USAGE_MINS);
            if (tuple) record->usage_mins = clamp_int16(tuple->value->int32, 0, 1440);

            tuple = dict_find(iterator, MESSAGE_KEY_MASK_COUNT);
            if (tuple) record->mask_count = clamp_int16(tuple->value->int32, 0, 999);

            tuple = dict_find(iterator, MESSAGE_KEY_LEAK_PCT);
            if (tuple) record->leak_pct = clamp_int16(tuple->value->int32, 0, 100);

            record->has_data = true;
        }
    }

    // -- Data transfer complete --
    Tuple *complete_tuple = dict_find(iterator, MESSAGE_KEY_DATA_COMPLETE);
    if (complete_tuple) {
        stop_loading_animation();
        s_sync_failed = false;
        s_app_state = STATE_DISPLAY;
        s_current_day_index = 0;

        // Record the sync timestamp for cooldown and display
        time_t now = time(NULL);
        s_last_sync_epoch = now;
        struct tm *local_time = localtime(&now);
        if (clock_is_24h_style()) {
            strftime(s_last_sync_time, sizeof(s_last_sync_time), "%H:%M", local_time);
        } else {
            strftime(s_last_sync_time, sizeof(s_last_sync_time), "%I:%M %p", local_time);
        }

        persist_save_records();
        persist_write_int(PERSIST_KEY_SYNC_EPOCH, (int)s_last_sync_epoch);
        layer_mark_dirty(s_canvas_layer);
        schedule_wakeup_exit(WAKEUP_EXIT_DELAY_MS);
    }
}

static void inbox_dropped_handler(AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "AppMessage dropped: reason=%d", reason);
}

static void request_retry_callback(void *data) {
    s_request_retry_timer = NULL;
    if (s_app_state == STATE_LOADING) {
        send_data_request();
    }
}

/**
 * The phone NACKs REQUEST_DATA when PebbleKit JS isn't running yet (common
 * right after launch), so resend it while we're still waiting for data.
 */
static void outbox_failed_handler(DictionaryIterator *iterator,
                                   AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "AppMessage outbox send failed: reason=%d", reason);
    if (s_app_state == STATE_LOADING && s_request_attempts < REQUEST_MAX_ATTEMPTS &&
        !s_request_retry_timer) {
        s_request_retry_timer = app_timer_register(REQUEST_RETRY_DELAY_MS,
                                                   request_retry_callback, NULL);
    }
}

/** No data arrived in time: fall back to cached data or show an error. */
static void loading_timeout_callback(void *data) {
    s_loading_timeout_timer = NULL;
    if (s_app_state != STATE_LOADING && s_app_state != STATE_CONNECTED) return;
    stop_loading_animation();

    // A half-received sequence may have cleared the in-memory records;
    // reload the last complete set from flash
    persist_load_records();
    if (s_total_days > 0) {
        s_sync_failed = true;
        s_app_state = STATE_DISPLAY;
    } else {
        snprintf(s_error_message, sizeof(s_error_message),
                 "No response from phone");
        s_error_is_cooldown = false;
        s_app_state = STATE_ERROR;
    }
    layer_mark_dirty(s_canvas_layer);
    schedule_wakeup_exit(0);
}

static void outbox_sent_handler(DictionaryIterator *iterator, void *context) {
    // No-op — success is the expected path
}

// ---------------------------------------------------------------------------
// Wakeup Handler — Background refresh triggered by scheduled wakeup
// ---------------------------------------------------------------------------

/** A wakeup fired while the app was already open: the user is here, so just refresh. */
static void wakeup_handler(WakeupId id, int32_t reason) {
    enter_loading_state();
    send_data_request();
    schedule_next_wakeup();
}

// ---------------------------------------------------------------------------
// Tap Handler — Double-tap to toggle simple mode
// ---------------------------------------------------------------------------

/**
 * Accelerometer tap handler. A single shake toggles simple mode
 * (text indicators vs numeric values) without opening phone settings.
 */
static void tap_handler(AccelAxisType axis, int32_t direction) {
    if (s_app_state != STATE_DISPLAY) return;

    s_text_indicators = !s_text_indicators;
    persist_write_bool(PERSIST_KEY_TEXT_INDICATORS, s_text_indicators);
    layer_mark_dirty(s_canvas_layer);

    // Brief vibration to confirm the toggle
    static const uint32_t toggle_vibe[] = { 50 };
    VibePattern pat = { .durations = toggle_vibe, .num_segments = 1 };
    vibes_enqueue_custom_pattern(pat);
}

// ---------------------------------------------------------------------------
// Window Handlers
// ---------------------------------------------------------------------------

static void main_window_load(Window *window) {
    Layer *root_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(root_layer);

    // Create the full-screen canvas layer for custom drawing
    s_canvas_layer = layer_create(bounds);
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(root_layer, s_canvas_layer);

    // Register button handlers (available because watchface=false)
    window_set_click_config_provider(window, click_config_provider);
}

static void main_window_unload(Window *window) {
    stop_loading_animation();
    layer_destroy(s_canvas_layer);
}

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------

static void init(void) {
    // Create and configure the main window
    s_main_window = window_create();
    window_set_background_color(s_main_window, COLOR_BACKGROUND);
    window_set_window_handlers(s_main_window, (WindowHandlers) {
        .load = main_window_load,
        .unload = main_window_unload
    });

    // Load any previously cached data for instant display
    persist_load_records();

    window_stack_push(s_main_window, true);

    // Register AppMessage callbacks BEFORE opening the channel
    app_message_register_inbox_received(inbox_received_handler);
    app_message_register_inbox_dropped(inbox_dropped_handler);
    app_message_register_outbox_failed(outbox_failed_handler);
    app_message_register_outbox_sent(outbox_sent_handler);
    app_message_open(APPMESSAGE_INBOX_SIZE, APPMESSAGE_OUTBOX_SIZE);

    // Subscribe to wakeup events for background refresh
    wakeup_service_subscribe(wakeup_handler);

    // Subscribe to tap events — toggle simple mode on wrist tap
    accel_tap_service_subscribe(tap_handler);

    // Check if the app was launched by a scheduled wakeup
    if (launch_reason() == APP_LAUNCH_WAKEUP) {
        WakeupId wakeup_id = 0;
        int32_t wakeup_reason = 0;
        wakeup_get_launch_event(&wakeup_id, &wakeup_reason);
        s_launched_by_wakeup = true;
    }

    time_t now = time(NULL);

    if (s_launched_by_wakeup) {
        // Daily background refresh: fetch unless synced within the hour,
        // then exit back to the watchface without user interaction.
        bool recently_synced = (s_last_sync_epoch != 0) &&
                               ((now - s_last_sync_epoch) < WAKEUP_FRESH_SECS);
        if (recently_synced) {
            schedule_wakeup_exit(0);
        } else {
            enter_loading_state();
            send_data_request();
            schedule_wakeup_exit(WAKEUP_TIMEOUT_MS);
        }
        schedule_next_wakeup();
        return;
    }

    // Only fetch fresh data if cache is stale or empty.
    // s_last_sync_epoch == 0 means fresh install or post-login (always fetch).
    // Otherwise, only fetch if more than sync_interval has passed.
    bool cache_is_stale = (s_last_sync_epoch == 0) ||
                          ((now - s_last_sync_epoch) >= s_sync_interval_hours * 3600);

    if (cache_is_stale || s_total_days == 0) {
        enter_loading_state();
        send_data_request();
    }
    // else: show cached data immediately, no API call

    schedule_next_wakeup();
}

static void deinit(void) {
    window_destroy(s_main_window);
}

int main(void) {
    init();
    app_event_loop();
    deinit();
}
