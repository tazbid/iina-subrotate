# Contributing to iina-plugin-subtitle-rotation

Thank you for considering a contribution! This document explains how to get
started, what the code does, and how to submit changes.

---

## Table of Contents

1. [Development Setup](#development-setup)
2. [Code Overview](#code-overview)
3. [Testing Changes](#testing-changes)
4. [Submitting a Pull Request](#submitting-a-pull-request)
5. [Reporting Bugs](#reporting-bugs)

---

## Development Setup

**Prerequisites**

- macOS 11 or later
- [IINA](https://iina.io) ≥ 1.3.0 with plugin support enabled
- A text editor (VS Code recommended)

**Clone and load the plugin in development mode**

```bash
git clone https://github.com/iina-plugin-subtitle-rotation/iina-plugin-subtitle-rotation
cd iina-plugin-subtitle-rotation
```

Open IINA → Preferences → Plugins → click the **+** button → select
the cloned folder. IINA loads it as a development plugin; changes to
`main.js` take effect after reloading the plugin (right-click the plugin
in the list → Reload).

---

## Code Overview

```
.
├── Info.json           Plugin manifest — identifier, version, permissions,
│                       preference defaults and page reference.
├── main.js             All plugin logic (~170 lines, no build step needed).
├── preferences.html    Native-feeling HTML preference UI.
├── package.json        Optional npm metadata for linting / packaging.
└── LICENSE             MIT
```

### How subtitle rotation works (in brief)

MPV applies `video-rotate` as a display transform **after** libass has
already rendered subtitle text into the video frame.  The result is that
subtitle text is rotated on-screen along with the video.

This plugin counter-rotates the text *inside* the libass coordinate space
via MPV's `sub-ass-style-overrides` list property, so the two rotations
cancel out and the viewer always reads horizontal text.

It also repositions subtitles (via ASS `Alignment` and `Margin` overrides)
so they appear near the visual bottom of the rotated video rather than at
the geometrically unexpected position they would occupy without adjustment.

See the `ROTATION_MAP` constant in `main.js` for the exact per-angle
mapping and the inline comments explaining the geometry.

### Key MPV properties used

| Property | Purpose |
|---|---|
| `video-rotate` | Observed — current CW rotation of video output (0/90/180/270) |
| `sub-ass-override` | Set to `yes` (or `force`) to allow style overrides |
| `sub-ass-style-overrides` | List property; entries like `Default.Angle=90` |
| `sub-ass-force-style` | Legacy fallback for older MPV builds |

---

## Testing Changes

### Manual test matrix

| Scenario | Expected result |
|---|---|
| `video-rotate=0`, SRT file | Subtitles horizontal at bottom — unchanged |
| `video-rotate=90`, SRT file | Text horizontal, near right edge of original frame (visual bottom after rotation) |
| `video-rotate=180`, SRT file | Text horizontal, near top of original frame (visual bottom after 180°) |
| `video-rotate=270`, SRT file | Text horizontal, near left edge (visual bottom after 270° CW) |
| `video-rotate=90`, complex ASS | Text readable; complex ASS positioning may shift (expected with `yes` mode) |
| `video-rotate=90`, complex ASS, **Force** mode | Text readable; original ASS styling overridden |
| Plugin disabled in prefs | No overrides applied; subtitles rendered by MPV as-is |
| File close / next file | Overrides cleared; no bleed between files |

### Console logging

Open IINA's plugin console (Plugins → [plugin name] → Show Console) and
watch the `[SubtitleRotation]` lines while changing `video-rotate` via
IINA's Video menu.

---

## Submitting a Pull Request

1. Fork the repository and create a branch: `git checkout -b feat/my-change`
2. Make your changes in `main.js` or `preferences.html`
3. Test against the matrix above
4. Open a PR with a clear description of what changed and why
5. Reference any relevant IINA or MPV issues

### Code style

- Plain ES5-compatible JavaScript (IINA's JS runtime may not support all
  modern syntax)
- No external dependencies — the plugin must work with zero `npm install`
- Keep comments minimal; the code should be self-explanatory

---

## Reporting Bugs

Open an issue and include:

- IINA version (`IINA → About`)
- macOS version
- Subtitle type (SRT / ASS / embedded)
- `video-rotate` value that triggers the problem
- Plugin console output (`[SubtitleRotation]` lines)
- Whether the problem persists with **Override Mode → Force**
