"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// IINA Plugin: Subtitle Rotation
// Automatically counter-rotates subtitle text so it remains readable when
// the video is rotated via MPV's video-rotate property.
//
// How it works:
//   1. Observe MPV's `video-rotate` property.
//   2. When rotation changes, inject ASS style overrides via MPV's
//      `sub-ass-style-overrides` list property (change-list command).
//   3. The injected overrides set:
//        - Default.Angle  : counter-rotation so text appears upright
//        - Default.Alignment : repositions subtitles to the visual bottom
//        - Default.MarginV/H : maintains a comfortable reading margin
//
// Subtitle rendering pipeline:
//   MPV feeds raw subtitle data → libass renders to video frame →
//   `video-rotate` rotates the entire output frame (video + subs).
//   By pre-rotating the text in libass coordinates, the two rotations cancel
//   out and the viewer sees horizontal, readable subtitles.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_PREFIX = "[SubtitleRotation]";
const PLUGIN_VERSION = "1.0.0";

// ── Rotation Map ─────────────────────────────────────────────────────────────
//
// In this MPV/IINA rendering path, `video-rotate` is a display-only transform:
// the video frame is rotated CW on-screen, but the subtitle overlay is
// composited AFTER that transform, so subtitles live in screen-space and are
// not affected by video-rotate.
//
// To make subtitle text rotate CW to match the video we apply an ASS Angle
// override.  ASS Angle is CCW degrees, so a visual CW rotation of R° requires
//   Angle = (360 - R) % 360
//
//   video-rotate │ ASS Angle │ Alignment anchor  │ Why
//   ─────────────────────────────────────────────────────────────────────────
//    0°           │  0        │ 2  bottom-center  │ default, unchanged
//   90°  (CW)     │ 270       │ 6  middle-right   │ rotated text hangs ↑↓
//                 │           │                   │ from right-center; never
//                 │           │                   │ exits screen top/bottom
//   180°          │ 180       │ 8  top-center     │ upside-down text sits at
//                 │           │                   │ top = visual bottom
//   270° (CW)     │  90       │ 4  middle-left    │ mirror of 90° case
//
// Why per-rotation Alignment matters:
//   With Alignment=2 (bottom-center) the ASS anchor is near the bottom edge.
//   When we rotate the glyph 90° CW around that anchor, the right half of the
//   text swings BELOW the anchor → off the bottom of the screen.
//   Moving the anchor to the middle of the appropriate edge (6 / 4) means
//   the rotated text extends equally above and below the anchor, staying
//   within the screen height.

const ROTATION_MAP = {
  0: {
    angle: 0,
    alignment: 2,   // bottom center — default, no change
    marginV: 30,
    marginH: 20,
  },
  90: {
    angle: 270,     // 90° CW visual (270° CCW in ASS notation)
    alignment: 6,   // middle-right anchor — rotated text balanced ↑↓ on screen
    marginV: 20,
    marginH: 30,
  },
  180: {
    angle: 180,     // upside-down
    alignment: 8,   // top-center — after 180° this is the visual bottom
    marginV: 30,
    marginH: 20,
  },
  270: {
    angle: 90,      // 270° CW visual (90° CCW in ASS notation)
    alignment: 4,   // middle-left anchor — mirror of 90° case
    marginV: 20,
    marginH: 30,
  },
};

// ── Plugin State ──────────────────────────────────────────────────────────────

const state = {
  currentRotation: -1,  // -1 = uninitialized; avoids redundant reapplication
  enabled: true,
  adjustPosition: true,
  showOSD: false,
  overrideMode: "yes",  // sub-ass-override value: "yes" | "force" | "scale"
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
    state.enabled        = p.get("enabled")        !== undefined ? p.get("enabled")        : true;
    state.adjustPosition = p.get("adjustPosition") !== undefined ? p.get("adjustPosition") : true;
    state.showOSD        = p.get("showOSD")        !== undefined ? p.get("showOSD")        : false;
    state.overrideMode   = p.get("overrideMode")   !== undefined ? p.get("overrideMode")   : "yes";
    log("Preferences: enabled=" + state.enabled
        + " adjustPosition=" + state.adjustPosition
        + " showOSD=" + state.showOSD
        + " overrideMode=" + state.overrideMode);
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
    logError("mpv.command('" + name + "', " + JSON.stringify(argsArray) + ") failed: " + e.message);
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
  try {
    return iina.mpv.getNumber(property);
  } catch (e) {
    return null;
  }
}

// ── Style Override Helpers ────────────────────────────────────────────────────

// Clears every entry from sub-ass-style-overrides.
// Falls back to directly setting the property to an empty string if the
// change-list command is unavailable (older MPV builds).
function clearStyleOverrides() {
  const ok = mpvCommand("change-list", ["sub-ass-style-overrides", "clr", ""]);
  if (!ok) {
    mpvSet("sub-ass-style-overrides", "");
    mpvSet("sub-ass-force-style", "");  // legacy fallback
  }
}

// Appends one "StyleName.Property=Value" entry to sub-ass-style-overrides.
function appendStyleOverride(entry) {
  const ok = mpvCommand("change-list", ["sub-ass-style-overrides", "append", entry]);
  if (!ok) {
    // Legacy fallback: sub-ass-force-style accepts comma-separated entries
    try {
      const current = iina.mpv.getString("sub-ass-force-style") || "";
      const updated = current ? current + "," + entry : entry;
      mpvSet("sub-ass-force-style", updated);
    } catch (e) {
      logError("Legacy override also failed for: " + entry);
    }
  }
}

// ── Core Rotation Logic ───────────────────────────────────────────────────────

/**
 * Reads the current video-rotate value and applies matching subtitle overrides.
 * Safe to call repeatedly; skips work when rotation has not changed.
 */
function applySubtitleRotation(rawRotation) {
  if (!state.enabled) {
    log("Plugin disabled, skipping rotation adjustment");
    return;
  }

  const rotation = ((Math.round(rawRotation || 0) % 360) + 360) % 360;

  if (rotation === state.currentRotation) {
    return; // nothing changed
  }

  const cfg = ROTATION_MAP[rotation] || ROTATION_MAP[0];
  log("Rotation change: " + state.currentRotation + "° → " + rotation + "°"
      + "  (ASS angle=" + cfg.angle + "°, alignment=" + cfg.alignment + ")");

  // 1. Allow ASS style overrides to take effect
  mpvSet("sub-ass-override", state.overrideMode);

  // 2. Wipe previous overrides injected by this plugin
  clearStyleOverrides();

  // 3. Inject new overrides when rotation is non-zero
  if (rotation !== 0) {
    appendStyleOverride("Default.Angle=" + cfg.angle);

    // Reposition the anchor to the correct screen edge for this rotation so
    // the rotated text bounding box stays within the visible window.
    appendStyleOverride("Default.Alignment=" + cfg.alignment);
    appendStyleOverride("Default.MarginV="   + cfg.marginV);
    appendStyleOverride("Default.MarginH="   + cfg.marginH);
  }

  // 4. Optional OSD notification
  if (state.showOSD) {
    try {
      const label = rotation === 0 ? "off" : rotation + "\xB0";  // °
      iina.osd.message("Subtitle rotation: " + label);
    } catch (e) {
      // OSD permission not granted; ignore
    }
  }

  state.currentRotation = rotation;
}

/** Wipes all overrides and restores neutral state. Called on file close. */
function resetSubtitleOverrides() {
  log("Resetting subtitle overrides to defaults");
  clearStyleOverrides();
  mpvSet("sub-ass-override", "yes");
  state.currentRotation = -1;
}

// ── Event Handlers ────────────────────────────────────────────────────────────

function onFileLoaded() {
  log("File loaded — reading initial video-rotate");
  const rotation = mpvGetNumber("video-rotate") || 0;
  applySubtitleRotation(rotation);
}

function onRotationChanged() {
  // IINA fires the event with no arguments; we must poll the property.
  const rotation = mpvGetNumber("video-rotate") || 0;
  applySubtitleRotation(rotation);
}

// ── Plugin Bootstrap ──────────────────────────────────────────────────────────

function init() {
  log("Subtitle Rotation Plugin v" + PLUGIN_VERSION + " initializing");
  loadPreferences();

  // ── Property observation ──────────────────────────────────────────────────
  try {
    iina.mpv.observe("video-rotate");
    log("Observing MPV property: video-rotate");
  } catch (e) {
    logError("Failed to observe video-rotate: " + e.message);
  }

  // ── Register event listeners ──────────────────────────────────────────────
  //
  // IINA Plugin API event names (verified against iina-plugin-definition):
  //
  //   iina.file-loaded           : playback file has loaded
  //   iina.file-started          : playback started (after loaded)
  //   mpv.{property-name}.changed: observed MPV property changed value
  //
  // The property-change callback receives NO arguments — current value must
  // be fetched via mpv.getNumber() / mpv.getString() etc.

  // File loaded
  try {
    iina.event.on("iina.file-loaded", onFileLoaded);
    log("Registered event: iina.file-loaded");
  } catch (e) {
    logError("Could not register iina.file-loaded: " + e.message);
  }

  // Rotation property change — primary handler
  try {
    iina.event.on("mpv.video-rotate.changed", onRotationChanged);
    log("Registered event: mpv.video-rotate.changed");
  } catch (e) {
    logError("Could not register mpv.video-rotate.changed: " + e.message);
  }

  // ── Fallback event names (different IINA versions use different formats) ──

  // Catch-all property change (older IINA builds)
  try {
    iina.event.on("iina.mpv-property-change", function(name, value) {
      if (name === "video-rotate") applySubtitleRotation(value);
    });
  } catch (e) {
    // Not available in this IINA version; primary handler covers it
  }

  // Per-property dot notation (some IINA builds)
  try {
    iina.event.on("iina.mpv-property-change.video-rotate", function(value) {
      applySubtitleRotation(value);
    });
  } catch (e) {
    // Silently skip
  }

  // End-of-file / file closed — reset so we don't pollute the next file
  try {
    iina.event.on("iina.file-ended", resetSubtitleOverrides);
  } catch (e) {
    try {
      iina.event.on("mpv.end-file.changed", resetSubtitleOverrides);
    } catch (e2) {
      // Best-effort; overrides naturally clear on next file-loaded
    }
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
