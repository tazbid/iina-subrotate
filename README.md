# iina-plugin-subtitle-rotation

Automatically rotates subtitles to match the video rotation in [IINA](https://iina.io).

## Install

1. Clone or download this repo
2. Open IINA → **Preferences → Plugins → +** → select the folder
3. Enable the plugin

> Requires IINA 1.3.0 or later with plugin support enabled.

## Usage

Rotate the video via **Video → Rotate Clockwise**. Subtitles move to the edge of the screen and rotate to match automatically.

## Settings

| Option | Default | Description |
|---|---|---|
| Enable Subtitle Rotation | On | Master on/off switch |
| Adjust Subtitle Position | On | Moves subtitle anchor to the correct screen edge. Disable if position looks wrong for your content. |
| Show OSD on Rotation Change | Off | Shows a brief message when rotation changes |

## How it works

IINA's `video-rotate` rotates the video display but subtitles are composited in screen-space after the transform. This plugin overrides MPV's `sub-align-x`, `sub-align-y`, and `sub-pos` properties to move the subtitle anchor to the correct edge, then applies an ASS `Angle` override to rotate the text.

| Rotation | Subtitle position |
|---|---|
| 90° CW | Left edge |
| 180° | Top edge |
| 270° CW | Right edge |

## License

MIT
