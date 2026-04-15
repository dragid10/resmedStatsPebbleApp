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
 * The app also refreshes automatically every 3 hours via the Wakeup API
 * and on every app launch.
 */

#include <pebble.h>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of days of sleep data to store and display. */
#define MAX_DAYS 7

/** Wakeup reason identifier (unused, but required by the API). */
#define WAKEUP_REASON_REFRESH 0

/** Interval between automatic background data refreshes (4 hours). */
#define WAKEUP_INTERVAL_SECS (4 * 3600)

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

// -- AppMessage Buffer Sizes --

/** Inbox buffer size — must fit one day's data (~70 bytes) with headroom. */
#define APPMESSAGE_INBOX_SIZE  256

/** Outbox buffer size — only sends REQUEST_DATA (very small). */
#define APPMESSAGE_OUTBOX_SIZE 64

/** Duration to show the "Connected!" screen before switching to data (ms). */
#define CONNECTED_DISPLAY_MS 1500

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
static char s_last_sync_time[SYNC_TIME_MAX_LEN];

// -- Loading Animation --
static int s_loading_dot_count = 0;      // Current number of dots (0-2)
static AppTimer *s_loading_anim_timer = NULL;

// -- Sync Timing --
static WakeupId s_wakeup_id = -1;
static bool s_launched_by_wakeup = false;
static time_t s_last_sync_epoch = 0;           // Unix timestamp of last successful sync

// ---------------------------------------------------------------------------
// Color Helpers — Map clinical values to color-coded indicators
// ---------------------------------------------------------------------------

/** Returns green/yellow/red based on the myAir sleep score. */
static GColor get_score_color(int score) {
    if (score >= SCORE_GOOD_THRESHOLD) return COLOR_SCORE_GOOD;
    if (score >= SCORE_OK_THRESHOLD) return COLOR_SCORE_OK;
    return COLOR_SCORE_BAD;
}

/** Returns green/yellow/red based on the AHI value (×10 to avoid floats). */
static GColor get_ahi_color(int ahi_x10) {
    if (ahi_x10 < AHI_NORMAL_THRESHOLD_X10) return COLOR_SCORE_GOOD;
    if (ahi_x10 < AHI_MILD_THRESHOLD_X10) return COLOR_SCORE_OK;
    return COLOR_SCORE_BAD;
}

/** Returns green/yellow/red based on CPAP usage duration in minutes. */
static GColor get_usage_color(int usage_mins) {
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

/** Load cached records from persistent storage (if any exist). */
static void persist_load_records(void) {
    if (persist_exists(PERSIST_KEY_RECORDS)) {
        persist_read_data(PERSIST_KEY_RECORDS, s_records, sizeof(s_records));
        s_total_days = persist_read_int(PERSIST_KEY_TOTAL);
        persist_read_string(PERSIST_KEY_SYNC, s_last_sync_time, sizeof(s_last_sync_time));
        if (s_total_days > 0) {
            s_app_state = STATE_DISPLAY;
        }
    }
}

// ---------------------------------------------------------------------------
// Wakeup — Schedule periodic background data refreshes
// ---------------------------------------------------------------------------

/** Schedule (or reschedule) the next automatic data refresh. */
static void schedule_next_wakeup(void) {
    if (s_wakeup_id >= 0) {
        wakeup_cancel(s_wakeup_id);
    }
    time_t next_wakeup_time = time(NULL) + WAKEUP_INTERVAL_SECS;
    s_wakeup_id = wakeup_schedule(next_wakeup_time, WAKEUP_REASON_REFRESH, true);
}

// ---------------------------------------------------------------------------
// AppMessage — Request data from the phone companion
// ---------------------------------------------------------------------------

/** Send a REQUEST_DATA message to the phone to trigger a data fetch. */
static void send_data_request(void) {
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
            static char day_counter[8];
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

/** Draw the large centered myAir score as the hero element. */
static void draw_score_hero(GContext *ctx, GRect bounds, SleepRecord *record) {
    int W = bounds.size.w;
    int H = bounds.size.h;
    // Position score below header (header is ~13% of height)
    int score_y = H * 15 / 100;

    if (!record || !record->has_data) return;

    // Large score number
    static char score_num[8];
    snprintf(score_num, sizeof(score_num), "%d", record->sleep_score);

    graphics_context_set_text_color(ctx, get_score_color(record->sleep_score));
    graphics_draw_text(ctx, score_num,
        fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD),
        GRect(0, score_y, W, 46),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    // "myAir Score" label below the number
    graphics_context_set_text_color(ctx, COLOR_LABEL);
    graphics_draw_text(ctx, "myAir Score",
        fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(0, score_y + 42, W, 16),
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

/** Draw the stats section below the score. */
static void draw_stats(GContext *ctx, GRect bounds, SleepRecord *record) {
    if (!record || !record->has_data) return;

    int W = bounds.size.w;
    int H = bounds.size.h;
    int footer_h = 18;
    // Calculate row height to fill space between score label and footer
    // Start stats at ~51% of screen height (below score + label)
    int stats_top = H * 51 / 100;
    int stats_bottom = H - footer_h - 2;
    int available = stats_bottom - stats_top;
    int row_h = available / 4;

    // Thin divider line above stats
    graphics_context_set_stroke_color(ctx, COLOR_CARD_BORDER);
    graphics_draw_line(ctx, GPoint(6, stats_top - 3), GPoint(W - 6, stats_top - 3));

    // Format values
    static char ahi_text[12];
    snprintf(ahi_text, sizeof(ahi_text), "%d.%d /hr",
             record->ahi_x10 / 10, record->ahi_x10 % 10);

    static char usage_text[12];
    snprintf(usage_text, sizeof(usage_text), "%dh %02dm",
             record->usage_mins / 60, record->usage_mins % 60);

    static char mask_text[8];
    snprintf(mask_text, sizeof(mask_text), "%d", record->mask_count);

    static char leak_text[8];
    snprintf(leak_text, sizeof(leak_text), "%d%%", record->leak_pct);

    draw_stat_row(ctx, stats_top, W, "Events", ahi_text, get_ahi_color(record->ahi_x10));
    draw_stat_row(ctx, stats_top + row_h, W, "Usage", usage_text, get_usage_color(record->usage_mins));
    draw_stat_row(ctx, stats_top + row_h * 2, W, "Mask Off", mask_text, COLOR_VALUE);
    draw_stat_row(ctx, stats_top + row_h * 3, W, "Leak", leak_text, COLOR_VALUE);
}

/** Draw the footer with sync info. */
static void draw_footer(GContext *ctx, GRect bounds) {
    int W = bounds.size.w;
    int H = bounds.size.h;

    const char *footer_text;
    static char sync_buf[40];

    if (s_last_sync_time[0] != '\0') {
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
    graphics_draw_text(ctx, "SELECT to retry",
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

/** Enter the loading state and start the dot animation. */
static void enter_loading_state(void) {
    s_app_state = STATE_LOADING;
    s_loading_dot_count = 0;
    layer_mark_dirty(s_canvas_layer);
    if (s_loading_anim_timer) {
        app_timer_cancel(s_loading_anim_timer);
    }
    s_loading_anim_timer = app_timer_register(LOADING_ANIMATION_MS,
                                               loading_animation_tick, NULL);
}

/** Stop the loading animation timer. */
static void stop_loading_animation(void) {
    if (s_loading_anim_timer) {
        app_timer_cancel(s_loading_anim_timer);
        s_loading_anim_timer = NULL;
    }
}

// ---------------------------------------------------------------------------
// Button Handlers
// ---------------------------------------------------------------------------

/** UP button: navigate to the previous day's record. */
static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
    if (s_app_state != STATE_DISPLAY || s_total_days == 0) return;
    s_current_day_index = (s_current_day_index - 1 + s_total_days) % s_total_days;
    layer_mark_dirty(s_canvas_layer);
}

/** DOWN button: navigate to the next day's record. */
static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
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
    // If not configured, just remind the user to log in — no API call
    if (s_app_state == STATE_NO_CONFIG) {
        return;
    }

    // Rate-limit manual syncs to avoid spamming the API
    if (s_app_state == STATE_DISPLAY && s_last_sync_epoch > 0) {
        time_t seconds_since_sync = time(NULL) - s_last_sync_epoch;
        if (seconds_since_sync < MANUAL_SYNC_COOLDOWN_SECS) {
            int mins_remaining = (MANUAL_SYNC_COOLDOWN_SECS - seconds_since_sync) / 60 + 1;
            snprintf(s_error_message, sizeof(s_error_message),
                     "Synced recently.\nRetry in %d min.", mins_remaining);
            s_app_state = STATE_ERROR;
            layer_mark_dirty(s_canvas_layer);
            return;
        }
    }

    enter_loading_state();
    send_data_request();
}

/** Register button click handlers for UP, DOWN, and SELECT. */
static void click_config_provider(void *context) {
    window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
    window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
    window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
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
            s_last_sync_epoch = 0;  // Clear cooldown so next login syncs immediately
        } else {
            snprintf(s_error_message, sizeof(s_error_message), "%s",
                     error_tuple->value->cstring);
            s_app_state = STATE_ERROR;
        }
        layer_mark_dirty(s_canvas_layer);
        return;
    }

    // -- Total days (first message in a data sequence) --
    // This message confirms that authentication succeeded and data was found.
    Tuple *total_days_tuple = dict_find(iterator, MESSAGE_KEY_TOTAL_DAYS);
    if (total_days_tuple && !dict_find(iterator, MESSAGE_KEY_DAY_INDEX)) {
        stop_loading_animation();
        s_total_days = (int)total_days_tuple->value->int32;
        s_current_day_index = 0;
        memset(s_records, 0, sizeof(s_records));

        // Clear the sync cooldown so fresh logins sync immediately
        s_last_sync_epoch = 0;

        // Show the "Connected!" confirmation screen
        s_app_state = STATE_CONNECTED;
        layer_mark_dirty(s_canvas_layer);
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

            tuple = dict_find(iterator, MESSAGE_KEY_SLEEP_SCORE);
            if (tuple) record->sleep_score = (int16_t)tuple->value->int32;

            tuple = dict_find(iterator, MESSAGE_KEY_AHI_X10);
            if (tuple) record->ahi_x10 = (int16_t)tuple->value->int32;

            tuple = dict_find(iterator, MESSAGE_KEY_USAGE_MINS);
            if (tuple) record->usage_mins = (int16_t)tuple->value->int32;

            tuple = dict_find(iterator, MESSAGE_KEY_MASK_COUNT);
            if (tuple) record->mask_count = (int16_t)tuple->value->int32;

            tuple = dict_find(iterator, MESSAGE_KEY_LEAK_PCT);
            if (tuple) record->leak_pct = (int16_t)tuple->value->int32;

            record->has_data = true;
        }
    }

    // -- Data transfer complete --
    Tuple *complete_tuple = dict_find(iterator, MESSAGE_KEY_DATA_COMPLETE);
    if (complete_tuple) {
        stop_loading_animation();
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
        layer_mark_dirty(s_canvas_layer);
    }
}

static void inbox_dropped_handler(AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "AppMessage dropped: reason=%d", reason);
}

static void outbox_failed_handler(DictionaryIterator *iterator,
                                   AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "AppMessage outbox send failed: reason=%d", reason);
}

static void outbox_sent_handler(DictionaryIterator *iterator, void *context) {
    APP_LOG(APP_LOG_LEVEL_DEBUG, "AppMessage outbox send succeeded");
}

// ---------------------------------------------------------------------------
// Wakeup Handler — Background refresh triggered by scheduled wakeup
// ---------------------------------------------------------------------------

static void wakeup_handler(WakeupId id, int32_t reason) {
    s_launched_by_wakeup = true;
    send_data_request();
    schedule_next_wakeup();
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

    // Check if the app was launched by a scheduled wakeup
    if (launch_reason() == APP_LAUNCH_WAKEUP) {
        WakeupId wakeup_id = 0;
        int32_t wakeup_reason = 0;
        wakeup_get_launch_event(&wakeup_id, &wakeup_reason);
        s_launched_by_wakeup = true;
    }

    // Request fresh data on every launch
    enter_loading_state();
    send_data_request();
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
