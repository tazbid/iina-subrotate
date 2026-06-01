"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// IINA Plugin: Subtitle Rotation  v1.0.0
//
// PROBLEM:
//   IINA stores its own subtitle alignment in the MPV properties
//   sub-align-x (default "center") and sub-align-y (default "bottom").
//   These properties override any ASS style-level Alignment we inject via
//   sub-ass-style-overrides, so position overrides were silently ignored.
//   Only Default.Angle took effect → text rotated but stayed centered across
//   the full video width.
//
// SOLUTION:
//   Directly set sub-align-x / sub-align-y / sub-pos at the MPV level
//   (same layer IINA writes to), so the subtitle anchor reliably moves to the
//   correct edge. Then inject Default.Angle + Default.WrapStyle via ASS.
//
//   video-rotate │ sub-align-x │ sub-align-y │ sub-pos │ Angle
//   ──────────────────────────────────────────────────────────────
//    0°           │ (restored)  │ (restored)  │ (saved) │  0
//   90°  CW       │ left        │ top         │  0      │ 270
//   180°          │ center      │ top         │  0      │ 180
//   270° CW       │ right       │ top         │  0      │  90
//
//   90° CW → LEFT:
//     When a landscape video is rotated 90° CW the original bottom edge
//     (where subtitles live) maps to the LEFT of the portrait display.
//     The LEFT black bar has empty space — subtitles go there without
//     covering the video content.
//
//   sub-align-y=top + sub-pos=0:
//     Anchor is at the top of the screen. The 90° CW-rotated text runs
//     DOWNWARD from that anchor, staying within the screen height for any
//     reasonable subtitle length.
//
//   Default.WrapStyle=2:
//     Disables automatic line-wrapping so the subtitle stays as one or two
//     explicit lines rather than fanning into many columns across the screen.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_PREFIX = "[SubtitleRotation]";
const PLUGIN_VERSION = "1.0.0";

// ── Rotation config ───────────────────────────────────────────────────────────

const ROTATION_MAP = {
  0: {
    // Restored from saved defaults — no overrides needed
    alignX: null, alignY: null, subPos: null, angle: 0,
  },
  90: {
    // 90° CW: original bottom → LEFT edge → push subtitle into left black bar
    alignX: "left",
    alignY: "top",
    subPos: 0,        // anchor at very top; rotated text runs downward, stays in screen
    angle: 270,       // 270° CCW = 90° CW visual rotation
  },
  180: {
    // 180°: upside-down; top of screen is visual bottom
    alignX: "center",
    alignY: "top",
    subPos: 0,
    angle: 180,
  },
  270: {
    // 270° CW: original bottom → RIGHT edge
    alignX: "right",
    alignY: "top",
    subPos: 0,
    angle: 90,        // 90° CCW = 270° CW visual rotation
  },
};

// ── Plugin State ──────────────────────────────────────────────────────────────

const state = {
  currentRotation: -1,   // -1 = not yet applied
  enabled: true,
  adjustPosition: true,  // when false: only rotate angle, don't move the anchor
  showOSD: false,
  // IINA's original subtitle alignment settings captured on first file load
  savedAlignX: "center",
  savedAlignY: "bottom",
  savedSubPos: 100,
  defaultsCaptured: false,
};

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) { console.log(LOG_PREFIX + " " + msg); }
function logError(msg) { console.error(LOG_PREFIX + " ERROR: " + msg); }

// ── Preferences ───────────────────────────────────────────────────────────────

function loadPreferences() {
  try {
    const p = iina.preferences;
    state.enabled        = p.get("enabled")        !== undefined ? p.get("enabled")        : true;
    state.adjustPosition = p.get("adjustPosition") !== undefined ? p.get("adjustPosition") : true;
    state.showOSD        = p.get("showOSD")        !== undefined ? p.get("showOSD")        : false;
    log("Preferences loaded: enabled=" + state.enabled
      + " adjustPosition=" + state.adjustPosition
      + " showOSD=" + state.showOSD);
  } catch (e) {
    log("Preferences unavailable, using defaults (" + e.message + ")");
  }
}

// ── MPV helpers ───────────────────────────────────────────────────────────────

function mpvCommand(name, args) {
  try { iina.mpv.command(name, args); return true; }
  catch (e) { logError("command(" + name + ") failed: " + e.message); return false; }
}

function mpvSet(prop, val) {
  try { iina.mpv.set(prop, val); return true; }
  catch (e) { logError("set(" + prop + "=" + val + ") failed: " + e.message); return false; }
}

function mpvGetNumber(prop) {
  try { return iina.mpv.getNumber(prop); } catch (e) { return null; }
}

function mpvGetString(prop) {
  try { return iina.mpv.getString(prop); } catch (e) { return null; }
}

// ── ASS style override helpers ────────────────────────────────────────────────

function clearStyleOverrides() {
  if (!mpvCommand("change-list", ["sub-ass-style-overrides", "clr", ""])) {
    mpvSet("sub-ass-style-overrides", "");
    mpvSet("sub-ass-force-style", "");
  }
}

function appendStyleOverride(entry) {
  if (!mpvCommand("change-list", ["sub-ass-style-overrides", "append", entry])) {
    try {
      const cur = iina.mpv.getString("sub-ass-force-style") || "";
      mpvSet("sub-ass-force-style", cur ? cur + "," + entry : entry);
    } catch (e) { logError("legacy override failed: " + entry); }
  }
}

// ── Save / restore IINA's own subtitle settings ───────────────────────────────

function captureDefaults() {
  if (state.defaultsCaptured) return;
  state.savedAlignX = mpvGetString("sub-align-x") || "center";
  state.savedAlignY = mpvGetString("sub-align-y") || "bottom";
  const pos = mpvGetNumber("sub-pos");
  state.savedSubPos = pos !== null ? pos : 100;
  state.defaultsCaptured = true;
  log("Saved IINA defaults: align-x=" + state.savedAlignX
    + " align-y=" + state.savedAlignY + " sub-pos=" + state.savedSubPos);
}

function restoreDefaults() {
  mpvSet("sub-align-x", state.savedAlignX);
  mpvSet("sub-align-y", state.savedAlignY);
  mpvSet("sub-pos",     state.savedSubPos);
  mpvSet("sub-ass-override", "yes");
  clearStyleOverrides();
  log("Restored IINA defaults");
}

// ── Core logic ────────────────────────────────────────────────────────────────

function applySubtitleRotation(rawRotation) {
  if (!state.enabled) { log("Disabled — skip"); return; }

  const rotation = ((Math.round(rawRotation || 0) % 360) + 360) % 360;
  if (rotation === state.currentRotation) return;

  captureDefaults();  // capture once before we touch anything

  log("Rotation " + state.currentRotation + "° → " + rotation + "°");

  if (rotation === 0) {
    restoreDefaults();
    state.currentRotation = 0;
    if (state.showOSD) { try { iina.osd.message("Subtitle rotation: off"); } catch(e){} }
    return;
  }

  const cfg = ROTATION_MAP[rotation] || ROTATION_MAP[90];

  // ── 1. Move the subtitle anchor (overrides IINA's align-x/y/sub-pos) ──────
  if (state.adjustPosition) {
    mpvSet("sub-align-x", cfg.alignX);
    mpvSet("sub-align-y", cfg.alignY);
    mpvSet("sub-pos",     cfg.subPos);
  }

  // ── 2. Inject ASS overrides ───────────────────────────────────────────────
  mpvSet("sub-ass-override", "force");
  clearStyleOverrides();
  appendStyleOverride("Default.Angle=" + cfg.angle);
  // No auto line-wrap: prevents the subtitle fanning into many columns
  appendStyleOverride("Default.WrapStyle=2");

  // ── 3. OSD notification ───────────────────────────────────────────────────
  if (state.showOSD) {
    try { iina.osd.message("Subtitle rotation: " + rotation + "\xB0"); } catch(e){}
  }

  state.currentRotation = rotation;
}

function resetSubtitleOverrides() {
  log("Resetting (file ended)");
  restoreDefaults();
  state.currentRotation = -1;
  state.defaultsCaptured = false;  // re-capture on next file
}

// ── Event handlers ────────────────────────────────────────────────────────────

function onFileLoaded() {
  log("File loaded");
  applySubtitleRotation(mpvGetNumber("video-rotate") || 0);
}

function onRotationChanged() {
  applySubtitleRotation(mpvGetNumber("video-rotate") || 0);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function init() {
  log("Subtitle Rotation Plugin v" + PLUGIN_VERSION + " initializing");
  loadPreferences();

  try { iina.mpv.observe("video-rotate"); log("Observing video-rotate"); }
  catch (e) { logError("observe video-rotate: " + e.message); }

  // Primary event name (iina-plugin-definition API)
  try { iina.event.on("mpv.video-rotate.changed", onRotationChanged);
        log("Registered mpv.video-rotate.changed"); }
  catch (e) { logError("register mpv.video-rotate.changed: " + e.message); }

  // Fallbacks for older IINA builds
  try { iina.event.on("iina.mpv-property-change", function(n, v) {
          if (n === "video-rotate") applySubtitleRotation(v); }); }
  catch (e) {}
  try { iina.event.on("iina.mpv-property-change.video-rotate", function(v) {
          applySubtitleRotation(v); }); }
  catch (e) {}

  // File lifecycle
  try { iina.event.on("iina.file-loaded", onFileLoaded);
        log("Registered iina.file-loaded"); }
  catch (e) { logError("register iina.file-loaded: " + e.message); }

  try { iina.event.on("iina.file-ended", resetSubtitleOverrides); }
  catch (e) {
    try { iina.event.on("mpv.end-file.changed", resetSubtitleOverrides); }
    catch (e2) {}
  }

  log("Init complete");
}

try { init(); }
catch (e) {
  console.error(LOG_PREFIX + " FATAL: " + e.message);
  if (e.stack) console.error(e.stack);
}
