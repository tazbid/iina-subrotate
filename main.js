"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// IINA Plugin: Subtitle Rotation  v1.0.0
//
// ROOT CAUSE (discovered through testing):
//   IINA writes its own subtitle alignment to the MPV properties
//   `sub-align-x` (default "center") and `sub-align-y` (default "bottom").
//   These properties override ASS style-level Alignment, so our earlier
//   `Default.Alignment=9` style override was silently ignored.
//   Only `Default.Angle` (text rotation) was taking effect, leaving the
//   subtitle centered+bottom and rotated — spanning the full video width.
//
// FIX:
//   1. Directly set `sub-align-x`, `sub-align-y`, `sub-pos` to move the
//      subtitle anchor to the correct edge (right for 90°, left for 270°).
//   2. Set `Default.Angle` via ASS style override to rotate the text.
//   3. Set `Default.WrapStyle=2` (no auto line-wrap) so the subtitle stays
//      as one column instead of fanning out across the screen.
//   4. Save the user's original alignment settings on first file load and
//      restore them when rotation returns to 0°.
//
// Per-rotation positioning:
//
//   video-rotate │ sub-align-x │ sub-align-y │ sub-pos │ ASS Angle
//   ─────────────────────────────────────────────────────────────────
//    0°           │ (restored)  │ (restored)  │ (saved) │  0
//   90°  (CW)     │ right       │ top         │  0      │ 270
//   180°          │ center      │ top         │  0      │ 180
//   270° (CW)     │ left        │ top         │  0      │  90
//
//   For 90° CW: anchor = top-right. 90° CW-rotated right-aligned text runs
//               DOWNWARD from the anchor → stays within screen height.
//   For 270°:   mirror on the left side.
//   sub-pos=0 keeps the anchor near the top edge so downward-running text
//   has maximum room before hitting the screen bottom.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_PREFIX = "[SubtitleRotation]";
const PLUGIN_VERSION = "1.0.0";

// ── Per-rotation config ───────────────────────────────────────────────────────

const ROTATION_MAP = {
  0: {
    // Use saved originals — restored in applySubtitleRotation
    alignX: null,
    alignY: null,
    subPos: null,
    angle: 0,
  },
  90: {
    alignX: "right",
    alignY: "top",
    subPos: 0,       // anchor at very top → text column runs down within screen
    angle: 270,      // 270° CCW = 90° CW visual
  },
  180: {
    alignX: "center",
    alignY: "top",
    subPos: 0,
    angle: 180,
  },
  270: {
    alignX: "left",
    alignY: "top",
    subPos: 0,
    angle: 90,       // 90° CCW = 270° CW visual
  },
};

// ── Plugin State ──────────────────────────────────────────────────────────────

const state = {
  currentRotation: -1,
  enabled: true,
  showOSD: false,
  // Saved user/IINA subtitle alignment settings (captured on first file load)
  savedAlignX: "center",
  savedAlignY: "bottom",
  savedSubPos: 100,
  defaultsCaptured: false,
};

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(LOG_PREFIX + " " + msg);
}

function logError(msg) {
  console.error(LOG_PREFIX + " ERROR: " + msg);
}

// ── Preferences ───────────────────────────────────────────────────────────────

function loadPreferences() {
  try {
    const p = iina.preferences;
    state.enabled  = p.get("enabled")  !== undefined ? p.get("enabled")  : true;
    state.showOSD  = p.get("showOSD")  !== undefined ? p.get("showOSD")  : false;
    log("Preferences: enabled=" + state.enabled + " showOSD=" + state.showOSD);
  } catch (e) {
    log("Could not load preferences, using defaults (" + e.message + ")");
  }
}

// ── MPV Wrappers ──────────────────────────────────────────────────────────────

function mpvCommand(name, argsArray) {
  try {
    iina.mpv.command(name, argsArray);
    return true;
  } catch (e) {
    logError("mpv.command('" + name + "') failed: " + e.message);
    return false;
  }
}

function mpvSet(property, value) {
  try {
    iina.mpv.set(property, value);
    return true;
  } catch (e) {
    logError("mpv.set('" + property + "', '" + value + "') failed: " + e.message);
    return false;
  }
}

function mpvGetNumber(property) {
  try { return iina.mpv.getNumber(property); } catch (e) { return null; }
}

function mpvGetString(property) {
  try { return iina.mpv.getString(property); } catch (e) { return null; }
}

// ── Style Override Helpers ────────────────────────────────────────────────────

function clearStyleOverrides() {
  const ok = mpvCommand("change-list", ["sub-ass-style-overrides", "clr", ""]);
  if (!ok) {
    mpvSet("sub-ass-style-overrides", "");
    mpvSet("sub-ass-force-style", "");
  }
}

function appendStyleOverride(entry) {
  const ok = mpvCommand("change-list", ["sub-ass-style-overrides", "append", entry]);
  if (!ok) {
    try {
      const current = iina.mpv.getString("sub-ass-force-style") || "";
      mpvSet("sub-ass-force-style", current ? current + "," + entry : entry);
    } catch (e) {
      logError("Legacy override failed for: " + entry);
    }
  }
}

// ── Save / Restore IINA's subtitle position defaults ─────────────────────────

// Called once when the first file loads (or on first rotation change).
// Captures IINA's current sub-align-x / sub-align-y / sub-pos so we can
// restore them when rotation returns to 0°.
function captureDefaults() {
  if (state.defaultsCaptured) return;
  state.savedAlignX = mpvGetString("sub-align-x") || "center";
  state.savedAlignY = mpvGetString("sub-align-y") || "bottom";
  state.savedSubPos = mpvGetNumber("sub-pos");
  if (state.savedSubPos === null) state.savedSubPos = 100;
  state.defaultsCaptured = true;
  log("Captured defaults: sub-align-x=" + state.savedAlignX
      + " sub-align-y=" + state.savedAlignY
      + " sub-pos=" + state.savedSubPos);
}

function restoreDefaults() {
  mpvSet("sub-align-x", state.savedAlignX);
  mpvSet("sub-align-y", state.savedAlignY);
  mpvSet("sub-pos",     state.savedSubPos);
  mpvSet("sub-ass-override", "yes");
  clearStyleOverrides();
  log("Restored defaults");
}

// ── Core Rotation Logic ───────────────────────────────────────────────────────

function applySubtitleRotation(rawRotation) {
  if (!state.enabled) {
    log("Plugin disabled — skipping");
    return;
  }

  const rotation = ((Math.round(rawRotation || 0) % 360) + 360) % 360;
  if (rotation === state.currentRotation) return;

  // Capture IINA's defaults before we touch anything (only once per session)
  captureDefaults();

  log("Rotation: " + state.currentRotation + "° → " + rotation + "°");

  // ── 0°: restore everything to what IINA had before ────────────────────────
  if (rotation === 0) {
    restoreDefaults();
    state.currentRotation = 0;
    return;
  }

  const cfg = ROTATION_MAP[rotation] || ROTATION_MAP[90];

  // ── Step 1: Move the subtitle anchor via MPV's own alignment properties ───
  // These override IINA's "Align X / Align Y" settings and take precedence
  // over ASS style-level Alignment, so the anchor reliably lands where we need.
  mpvSet("sub-align-x", cfg.alignX);
  mpvSet("sub-align-y", cfg.alignY);
  mpvSet("sub-pos",     cfg.subPos);

  // ── Step 2: Allow ASS overrides and inject them ───────────────────────────
  mpvSet("sub-ass-override", "force");
  clearStyleOverrides();

  // Rotate the glyph bitmaps to match the video's CW rotation
  appendStyleOverride("Default.Angle=" + cfg.angle);

  // Disable automatic line-wrapping so the subtitle stays as a single column
  // instead of wrapping into multiple columns that fan across the screen.
  // Explicit line-breaks (\N in ASS / blank lines in SRT) still apply.
  appendStyleOverride("Default.WrapStyle=2");

  // ── Step 3: Optional OSD ──────────────────────────────────────────────────
  if (state.showOSD) {
    try { iina.osd.message("Subtitle rotation: " + rotation + "\xB0"); } catch (e) {}
  }

  state.currentRotation = rotation;
}

function resetSubtitleOverrides() {
  log("File ended — resetting subtitle state");
  restoreDefaults();
  state.currentRotation = -1;
  state.defaultsCaptured = false;  // re-capture on next file (different IINA settings may apply)
}

// ── Event Handlers ────────────────────────────────────────────────────────────

function onFileLoaded() {
  log("File loaded — reading initial video-rotate");
  const rotation = mpvGetNumber("video-rotate") || 0;
  applySubtitleRotation(rotation);
}

function onRotationChanged() {
  const rotation = mpvGetNumber("video-rotate") || 0;
  applySubtitleRotation(rotation);
}

// ── Plugin Bootstrap ──────────────────────────────────────────────────────────

function init() {
  log("Subtitle Rotation Plugin v" + PLUGIN_VERSION + " initializing");
  loadPreferences();

  try {
    iina.mpv.observe("video-rotate");
    log("Observing: video-rotate");
  } catch (e) {
    logError("Failed to observe video-rotate: " + e.message);
  }

  // Primary event (iina-plugin-definition API)
  try {
    iina.event.on("mpv.video-rotate.changed", onRotationChanged);
    log("Registered: mpv.video-rotate.changed");
  } catch (e) {
    logError("Could not register mpv.video-rotate.changed: " + e.message);
  }

  // Fallback — catch-all property change (older IINA builds)
  try {
    iina.event.on("iina.mpv-property-change", function(name, value) {
      if (name === "video-rotate") applySubtitleRotation(value);
    });
  } catch (e) { /* silent */ }

  // Fallback — per-property format (some IINA builds)
  try {
    iina.event.on("iina.mpv-property-change.video-rotate", function(value) {
      applySubtitleRotation(value);
    });
  } catch (e) { /* silent */ }

  // File lifecycle
  try {
    iina.event.on("iina.file-loaded", onFileLoaded);
    log("Registered: iina.file-loaded");
  } catch (e) {
    logError("Could not register iina.file-loaded: " + e.message);
  }

  try {
    iina.event.on("iina.file-ended", resetSubtitleOverrides);
  } catch (e) {
    try { iina.event.on("mpv.end-file.changed", resetSubtitleOverrides); } catch (e2) {}
  }

  log("Plugin initialization complete");
}

// ── Entry Point ───────────────────────────────────────────────────────────────
try {
  init();
} catch (e) {
  console.error(LOG_PREFIX + " FATAL: " + e.message);
  if (e.stack) console.error(e.stack);
}
