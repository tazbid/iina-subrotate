# iina-plugin-subtitle-rotation

An IINA plugin that automatically rotates subtitle text to match the
video's current rotation angle, making subtitles readable when you watch
vertically recorded or manually rotated content.

---

## Table of Contents

1. [Installation](#installation)
2. [Usage](#usage)
3. [Settings](#settings)
4. [Technical Investigation](#technical-investigation)
5. [Architecture](#architecture)
6. [Validation & Testing](#validation--testing)
7. [Fallback Plan & Limitations](#fallback-plan--limitations)
8. [Contributing](#contributing)
9. [License](#license)

---

## Installation

### Method A — Development install (recommended for testing)

1. Download or clone this repository:
   ```bash
   git clone https://github.com/iina-plugin-subtitle-rotation/iina-plugin-subtitle-rotation
   ```
2. Open **IINA**.
3. Go to **IINA → Preferences → Plugins** (requires IINA ≥ 1.3.0).
4. Click **+** → **Load Plugin from Folder**.
5. Select the cloned `iina-plugin-subtitle-rotation` folder.
6. The plugin appears in the list; toggle it on.

### Method B — Packaged install

1. Download `iina-plugin-subtitle-rotation.iinaplugin` from the
   [Releases](https://github.com/iina-plugin-subtitle-rotation/iina-plugin-subtitle-rotation/releases) page.
2. Double-click the `.iinaplugin` file — IINA installs it automatically.

### Enable plugin support in IINA

IINA's plugin system may be behind a feature flag on your build:

- **IINA 1.3.x nightly / beta**: plugins enabled by default.
- **IINA 1.2.x stable**: launch with `open -a IINA --args --enable-plugin`
  or check **Preferences → General → Enable plugin support**.

---

## Usage

The plugin works automatically once installed:

1. Open any video with subtitles.
2. Rotate the video via **Video → Rotate Clockwise / Counterclockwise**
   (or the keyboard shortcut, typically assigned in IINA preferences).
3. Subtitles instantly reorient to remain readable.

No manual steps are needed. The plugin observes MPV's `video-rotate`
property in real time and reapplies style overrides on every change.

---

## Settings

Open **Preferences → Plugins → Subtitle Rotation → Preferences**:

| Setting | Default | Description |
|---|---|---|
| Enable Subtitle Rotation | On | Master switch. When off, no overrides are applied. |
| Adjust Subtitle Position | On | Repositions subtitles to the visual bottom of the rotated video. Disable if subtitles jump to unexpected locations in complex ASS files. |
| Show OSD on Rotation Change | Off | Briefly shows "Subtitle rotation: 90°" on-screen. |
| ASS Override Mode | Yes | Controls `sub-ass-override`. See below. |

### ASS Override Mode details

| Value | Behaviour |
|---|---|
| **Yes** | Recommended. Preserves existing ASS colors, sizes, and custom style properties. Only the `Default` style is angle- and position-overridden. |
| **Force** | Forces *all* subtitle text through the overridden Default style. Use when subtitles define custom style names and rotation is not applied in `Yes` mode. Loses original ASS formatting (colors, custom fonts, karaoke). |
| **Scale** | Minimal mode; unlikely to apply angle overrides correctly — present for diagnostics only. |

---

## Technical Investigation

### How IINA renders subtitles

IINA is a native macOS media player that embeds **mpv** as its playback
engine. The subtitle rendering pipeline is:

```
Subtitle source (SRT / ASS / embedded track)
        │
        ▼
  MPV demuxer reads subtitle packets
        │
        ▼
  libass  ──  converts SRT → internal ASS, parses ASS styles,
              rasterises glyph bitmaps into a RGBA overlay
              at the *video frame's native resolution*
        │
        ▼
  MPV video output (VO) compositor
        │  composites subtitle overlay onto video frame
        ▼
  Display transform  ←── video-rotate applied HERE
        │
        ▼
  macOS Metal / OpenGL surface
```

The critical detail: **libass rasterises subtitles in the video's original
coordinate space before the `video-rotate` transform is applied.**

### Why subtitles don't rotate today

When a user sets `video-rotate=90` in MPV (which is what IINA does when
you click Rotate Clockwise):

1. The video frame and its composited subtitle overlay are rotated together
   by the display transform.
2. Subtitle text that was horizontal in the original frame now appears
   rotated 90° on-screen.
3. The viewer must tilt their head 90° to read it — which defeats the
   purpose of rotating the video.

Neither libass nor IINA's plugin API exposes a "rotate subtitles to match
display rotation" hook. The only way to influence subtitle rendering is
through MPV's subtitle property interface, which exposes the ASS styling
pipeline.

### What APIs can be used

#### 1. `sub-ass-style-overrides` (chosen approach)

MPV string-list property. Each entry is `"StyleName.PropertyName=Value"`.
After setting `sub-ass-override` to `yes` or `force`, these entries are
merged into the Default (or all) ASS style(s) before rasterisation.

Key ASS style properties we use:

| ASS Property | Effect |
|---|---|
| `Angle` | Counter-clockwise rotation of rendered glyph bitmaps |
| `Alignment` | Numpad-notation anchor point (7–9 = top, 4–6 = middle, 1–3 = bottom) |
| `MarginV` | Vertical margin from the aligned edge, in pixels |
| `MarginH` | Horizontal margin from the aligned edge, in pixels |

Set via `change-list` MPV command:
```
change-list sub-ass-style-overrides append "Default.Angle=90"
```

#### 2. `sub-ass-override` MPV property

Controls whether `sub-ass-style-overrides` is honoured:
- `no`    — ignores overrides entirely
- `yes`   — merges overrides into existing ASS styles
- `force` — replaces all styles with the overridden Default
- `scale` — only accepts scale-related overrides

#### 3. `video-rotate` MPV property (observed)

Integer, 0–359. IINA typically writes 0, 90, 180, 270.
Observed via the IINA Plugin API:
```javascript
iina.mpv.observe("video-rotate");
iina.event.on("mpv.video-rotate.changed", () => { … });
```

#### 4. Subtitle filter chain (`vf` / `sf`)

MPV has an `sf` (subtitle filter) property analogous to `vf` for video.
As of MPV 0.37, no subtitle filter for rotation exists in the public API.
This avenue was explored but ruled out.

#### 5. OSD / overlay rendering

IINA plugins can render an OSD overlay (`iina.overlay`). It would be
possible to completely bypass MPV subtitle rendering, extract subtitle
text via `sub-text`, and re-render it at the correct angle. This was
considered as the fallback approach but is significantly more complex,
does not support styled ASS correctly, and introduces timing issues.
It is documented in the [Fallback Plan](#fallback-plan--limitations)
section below.

### Why this approach works

The geometry of the correction:

- libass applies `Angle=A` as an **CCW** rotation of the glyph bitmaps.
- The display transform applies `video-rotate=R` as a **CW** rotation.
- Net screen rotation of the text = R (CW) − A (CCW).
- Setting `A = R` makes the net rotation 0° — text appears horizontal.

For the position correction, consider `video-rotate=90` (CW):

```
Original video frame:          After 90° CW display rotation:
┌──────────────────────┐        ┌──────────────────────┐
│                      │        │                      │
│       content        │   →    │       content        │
│                      │        │                      │
│  [subtitle at btm]   │        │  [subs now on LEFT]  │
└──────────────────────┘        └──────────────────────┘
```

To put subtitles at the visual bottom after the 90° CW rotation, they
must be at the **right edge** (Alignment=6) of the *original* frame.
After the 90° CW rotation, right-edge becomes bottom-edge.

| video-rotate | Target position in original frame | ASS Alignment |
|---|---|---|
| 0° | Bottom center | 2 |
| 90° CW | Middle right | 6 |
| 180° | Top center | 8 |
| 270° CW | Middle left | 4 |

---

## Architecture

### Plugin structure

```
iina-plugin-subtitle-rotation/
├── Info.json           Manifest: identifier, version, permissions, defaults
├── main.js             Plugin entry point — all logic lives here
├── preferences.html    HTML preference page rendered by IINA
├── package.json        npm metadata (linting, packaging helpers)
├── README.md
├── LICENSE
├── CONTRIBUTING.md
└── .gitignore
```

### Component diagram

```
┌─────────────────────────────────────────────────────────────┐
│  IINA Plugin Host                                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  main.js                                            │   │
│  │                                                     │   │
│  │  init()                                             │   │
│  │   ├─ loadPreferences() ──► iina.preferences         │   │
│  │   ├─ iina.mpv.observe("video-rotate")               │   │
│  │   └─ iina.event.on(...)                             │   │
│  │        │                                            │   │
│  │        ├── "iina.file-loaded"                       │   │
│  │        │        └─► onFileLoaded()                  │   │
│  │        │              └─► applySubtitleRotation()   │   │
│  │        │                                            │   │
│  │        └── "mpv.video-rotate.changed"               │   │
│  │                 └─► onRotationChanged()             │   │
│  │                       └─► applySubtitleRotation()   │   │
│  │                                                     │   │
│  │  applySubtitleRotation(angle)                       │   │
│  │   ├─ Lookup ROTATION_MAP[angle]                     │   │
│  │   ├─ mpv.set("sub-ass-override", mode)              │   │
│  │   ├─ clearStyleOverrides()                          │   │
│  │   │   └─ change-list sub-ass-style-overrides clr    │   │
│  │   ├─ appendStyleOverride("Default.Angle=…")         │   │
│  │   ├─ appendStyleOverride("Default.Alignment=…")     │   │
│  │   ├─ appendStyleOverride("Default.MarginV=…")       │   │
│  │   └─ appendStyleOverride("Default.MarginH=…")       │   │
│  │       └─ change-list sub-ass-style-overrides append │   │
│  └─────────────────────────────────────────────────────┘   │
│                        │                                    │
│                        ▼                                    │
│                   MPV core                                  │
│                   sub-ass-style-overrides property          │
│                        │                                    │
│                        ▼                                    │
│                   libass renderer                           │
│                   (applies Angle / Alignment / Margin)      │
│                        │                                    │
│                        ▼                                    │
│                   VO compositor + video-rotate transform    │
└─────────────────────────────────────────────────────────────┘
```

### Rotation detection logic

```
File loads
    │
    ▼
mpv.getNumber("video-rotate") ──► initial angle
    │
    ▼
applySubtitleRotation(angle)
    │
    ├─ angle already applied? → skip (state.currentRotation guard)
    │
    ├─ normalize: ((angle % 360) + 360) % 360
    │
    └─ ROTATION_MAP[normalizedAngle] → { angle, alignment, marginV, marginH }

video-rotate property change event fires
    │
    ▼
mpv.getNumber("video-rotate") ──► new angle
    │
    └─ applySubtitleRotation(newAngle)
```

### Event fallback chain

IINA plugin API event names vary across IINA versions. The plugin registers
three handler patterns and silently ignores the ones that throw:

```
Priority 1: "mpv.video-rotate.changed"          ← iina-plugin-definition API
Priority 2: "iina.mpv-property-change"          ← catch-all, older IINA builds
Priority 3: "iina.mpv-property-change.video-rotate"  ← per-property, some builds
```

---

## Validation & Testing

### External SRT subtitles

1. Open a video with an external `.srt` file (same filename, same folder).
2. Confirm subtitles are visible at `video-rotate=0`.
3. Press the rotate shortcut → `video-rotate=90`.
4. **Expected**: text is horizontal, positioned near the right edge of the
   video frame (which is the visual bottom after 90° CW rotation).
5. Rotate to 180°, 270°, 0° and confirm each step.

### ASS/SSA subtitles

1. Use a test `.ass` file with a `Default` style and simple bottom-center
   positioned dialogue lines.
2. Repeat the rotation steps above.
3. **Expected**: same as SRT.
4. For ASS files with custom style names (not `Default`):
   - Switch **Override Mode → Force** in preferences.
   - This forces all text through the overridden Default style.
   - Original ASS colours/positions are lost; text becomes readable.

### Embedded subtitles

1. Open a `.mkv` or `.mp4` with embedded subtitle tracks.
2. Select a subtitle track via **Subtitles → [track name]**.
3. Rotate and observe — behaviour is identical to external SRT/ASS.

### Different rotation angles

```bash
# Force a specific rotation for testing via mpv console (` key in IINA)
set video-rotate 90
set video-rotate 180
set video-rotate 270
set video-rotate 0
```

### Reading plugin logs

Open **IINA → Plugins → Subtitle Rotation → Show Console**.
All log lines are prefixed with `[SubtitleRotation]`. You should see:

```
[SubtitleRotation] Subtitle Rotation Plugin v1.0.0 initializing
[SubtitleRotation] Observing MPV property: video-rotate
[SubtitleRotation] Registered event: iina.file-loaded
[SubtitleRotation] File loaded — reading initial video-rotate
[SubtitleRotation] Rotation change: -1° → 0°  (ASS angle=0°, alignment=2)
[SubtitleRotation] Rotation change: 0° → 90°  (ASS angle=90°, alignment=6)
```

---

## Fallback Plan & Limitations

### Why perfect rotation is hard

The core limitation is architectural: libass renders subtitles in the
**video's pre-rotation coordinate space**. The `sub-ass-style-overrides`
approach works well for simple content (SRT, single-style ASS) but has
the following constraints:

| Scenario | Behaviour | Workaround |
|---|---|---|
| SRT subtitles | ✅ Full rotation + repositioning | — |
| ASS with only `Default` style | ✅ Full rotation + repositioning | — |
| ASS with named custom styles (e.g. `Signs`, `OP`) | ⚠️ Only `Default` style is rotated | Use Force mode |
| Force mode + complex ASS | ✅ Text readable, ❌ original formatting lost | Accept trade-off |
| Inline ASS override tags (`\pos`, `\an`, `\frz`) | ⚠️ Inline tags take precedence over style overrides | No current workaround |

### Inline tag limitation

ASS dialogue lines can embed per-line angle overrides such as
`{\frz45}Hello` (rotate 45° around the baseline). These take priority over
style-level `Angle` in most libass builds, meaning our counter-rotation is
ignored for those specific lines. This is an inherent limitation of the
ASS/libass specification and cannot be solved via the `sub-ass-style-overrides`
mechanism alone.

**Smallest possible fix at the MPV/libass level** (for contributors who
want to dig deeper):

MPV would need to expose a "global subtitle display rotation" property that
is applied *after* libass renders, similar to how `video-rotate` works for
the video plane. The implementation would require:

1. A new MPV property `sub-rotate` (integer, 0–359).
2. In the VO compositor, after libass rasterisation, apply an affine
   transform to the subtitle bitmap layer using the same rotation matrix
   as `video-rotate`.
3. Optionally: a `sub-rotate-auto` flag that mirrors `video-rotate`
   automatically.

This would be a ~50–100 line patch to `video/out/vo.c` and
`video/out/gpu/video.c` in the mpv source tree, and would solve the
problem definitively for all subtitle types.

### OSD overlay fallback (proof-of-concept)

If style overrides stop working in a future MPV/libass version, a
different approach is possible via IINA's `iina.overlay` API:

1. Poll `sub-text` MPV property for current subtitle text.
2. Clear MPV subtitles (`sub-visibility=no`).
3. Render a `<canvas>` in the IINA overlay at the correct angle.

This is not implemented in the current release because:
- It cannot reproduce styled ASS (colors, italic, bold, size).
- It has timing complexity (subtitle start/end sync).
- `iina.overlay` has limited text-layout control compared to libass.

A proof-of-concept can be enabled by setting `USE_OVERLAY_FALLBACK=true`
at the top of `main.js` (hook point is included in the code but the
renderer is not yet written — PRs welcome).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
