# Loopcheck

A small, mobile-friendly video loop workshop for GitHub Pages. Select a local clip, compare the original with a repaired loop, and download the result. Processing stays in your browser; there are no uploads, accounts, analytics, CDN requests, or build step.

## Use it

1. Choose or drop a video, up to 30 seconds and 100 MB. Wait for frames and audio to decode.
2. Use **Original / Repaired** to compare. **Play across the join** starts just before the boundary so you can audition it quickly. Switching versions or changing settings pauses playback.
3. Adjust **Picture + sound blend**. Start around 100–250 ms for nearly matching endpoints. A dissolve mixes ending frames with opening frames; it softens noise differences but may show ghosting on moving objects. It does not synthesize missing motion or denoise the whole clip.
4. Choose an audio crossfade: **Constant power** is a useful starting point for ambience; **Linear** avoids a volume swell when both ends contain similar sound. Constant-power blends that exceed full scale receive a single static gain reduction across the whole clip, shown in the repair summary.
5. Inspect the audio diagnosis. If there are unwanted quiet edges, enable **Remove detected quiet edges**. This is off by default because silence can be intentional. It removes picture and audio together to preserve sync, capped at 500 ms or a quarter of the clip per edge. Quiet means every channel is below −60 dBFS; fully quiet tracks are not trimmed automatically.
6. Choose **Download size**: Original resolution re-decodes the source; **Smaller · use cached preview** exports the displayed preview resolution without another video decode. Smaller is an explicit quality/size tradeoff and a useful retry on devices that stall during full-resolution export. Press **Prepare download**, then **Download repaired video**. The download always uses the repair settings, even when Original is selected. Muting affects preview only. Changing settings invalidates the old download. Export can be cancelled during pending codec operations. The progress message identifies decoding, encoding, or finalization; a single operation with no response for 30 seconds produces a stage-specific error instead of waiting indefinitely. Cancellation and errors restore controls after bounded cleanup. An unresponsive browser codec may not release its resources immediately.
7. Reopen the downloaded file and select Original to inspect the encoded result without applying another repair.

The repaired duration is the original duration minus any quiet-edge cuts and one overlap length. Picture and sound share that same overlap. At zero overlap, crossfades are disabled; optional quiet-edge cuts still apply.

A dissolve can look natural when composition and motion nearly match. A long dissolve is not necessarily better: it may replace a hard seam with visible double images. Missing sound cannot be reconstructed; quiet-edge removal and overlapping available sound can help avoid a cutout.

## Hosting

Serve the directory with `python3 -m http.server 8000` and visit `http://localhost:8000`. ES modules require HTTP rather than opening `index.html` directly. On another machine, use HTTPS, such as T3’s file relay; WebCodecs requires a secure context. Localhost also qualifies.

For GitHub Pages, push these files and deploy the branch’s root directory. Keep `vendor` and the JavaScript modules alongside `index.html`. Relative asset paths work under repository subpaths. No npm installation or build is needed to host the app.

## Playback and repair

[Mediabunny](https://mediabunny.dev/guide/media-sinks) demuxes and decodes timestamped frames and PCM. The pinned 1.66.0 bundle, MPL 2.0 license, and corresponding original source archive are included in `vendor`.

The original preview caches frames as ImageBitmaps with their presentation timestamps, including variable frame timing. PCM chunks are assembled at their timestamps. Track offsets and gaps are preserved: shorter audio leaves silence through the combined timeline, and shorter video holds its final frame. The diagnosis explicitly reports a timeline that extends past the decoded audio; this is distinct from quiet samples already present in the source.

A repair starts after the opening overlap and blends the tail into that opening. At wrap, the opening continues from where the blend left off, rather than repeating the overlapping segment twice. Picture uses a smoothstep opacity dissolve; audio uses constant-power sine/cosine weights or linear weights. Optional quiet-edge cuts and overlap boundaries are quantized to audio samples.

One continuously looping Web Audio buffer drives each preview. Canvas presentation follows the audio output clock where supported, otherwise the AudioContext clock. There are no seeks or decoder restarts at each loop boundary. Playback pauses on hidden pages and audio interruption. Pause, file/version/settings changes, and export invalidate pending audio-resume requests, so a late Play completion cannot restart a paused or exporting preview. Display callback stalls over 100 ms produce a warning.

## Download behavior

[Export](https://mediabunny.dev/guide/writing-media-files) decodes the original file again using two sequential frame readers for the tail and opening. It uses the same repair timeline and visual compositor as preview, at the original display resolution rounded up to even dimensions. A downscaled preview does not become the export master.

The output uses the detected source frame rate as its base cadence, capped at 60 fps (30 fps if unknown). Outside the dissolve, variable frame rate is sampled onto that cadence. The dissolve gets explicit variable-duration frames at roughly 60 fps, with at least quarter/midpoint/three-quarter samples even for an overlap shorter than one normal frame. This prevents a short repair from disappearing between export samples. Frame durations partition the same repaired timeline; the audio period is unchanged. Very short blends may still be difficult to perceive at the target display’s refresh rate. Video and repaired audio receive explicit timestamps; export is independent of screen refresh rate or elapsed wall time. Only the primary video and audio are exported; extra tracks and source metadata are not retained.

Original-size export uses sequential decoded-sample readers with explicitly released samples and one lookahead frame per reader, rather than sparse timestamp-generator wrappers. Smaller export uses the already decoded preview frames and the same repair timeline/compositor.

The app prefers H.264/AAC MP4, falling back to VP9/Opus WebM when the browser cannot encode MP4 with the required audio. For example, the tested Linux Chrome supports H.264 output but lacks AAC encoding, so clips with audio export as WebM. If neither supported pair can encode the original resolution/audio format, export reports an error. It never silently removes audio or reduces export resolution; the smaller resolution is used only when you select it. Full-resolution encoding can be slower and use more memory than preview, especially on phones.

**A repaired file is not a universal gapless-playback guarantee.** Another player can add a restart gap, and codecs/containers may affect padding and timing. Crossfades cannot fix all motion, lighting, or sound mismatches. Test downloads in the intended player.

## Limits

- Requires HTTPS or localhost, WebCodecs video decoding, Web Audio, ImageBitmap, and ES modules. Codec support varies by device and browser. Video/audio encoding support is additionally required to download. There is no native-player fallback masquerading as gapless playback.
- Input is limited to 100 MB and 30 seconds. A 128 MiB cache budget reserves space for frames plus original and repaired PCM. Decoder working memory, transient repair allocations, GPU overhead, and full-resolution export buffers are additional; this is not a total browser-memory limit.
- Preview resolution is reduced to fit that budget, capped at 1280 pixels on its longest edge. Actual dimensions and cached frame count are shown. Unexpectedly large variable-rate files can still exceed the cache and be rejected.
- Decoding, display refresh, missed animation frames, audio interruptions, and source silence still affect playback. Canvas color conversion and spatial scaling mean this is not a color-critical mastering tool.
- Physical phone playback, memory pressure, and encoding still require testing on target devices. Fullscreen fits the entire frame inside the viewport with letterboxing as needed and an in-player exit button. Mobile browsers without element fullscreen use an in-page expanded view with the same sizing.

## Verification

Run `npm test` (Node only) for timeline wrap, variable frame selection, PCM assembly, track offsets, trimming, crossfade continuity, clipping prevention, and pause/resume. Unit tests render a hard audio seam into a small sample-to-sample transition and verify both tracks use the same shortened period.

For integration tests, run `npm ci` then `npm run test:browser`. Requires FFmpeg/ffprobe with libx264 and an installed Chrome; set `CHROME_BIN` if needed. These are development tools only. Tests create temporary media and a loopback HTTP server, then clean up.

Browser checks cover H.264/AAC decoding, repeated cached playback, sample-by-sample OfflineAudioContext looping, mute, pause, invalid files, rapid replacement, phone-width layout, visual blend pixels, quiet-edge diagnosis/removal, comparison, download, and cancellation. Actual WebM audio/video and MP4 video exports are inspected with ffprobe. A synthetic ~200 ms audio tail gap is removed; the download is decoded with FFmpeg and reopened in the app to check for regenerated silence. A 1440 × 810 source exports at that resolution despite its 1280 × 720 preview. These checks do not measure physical speaker output or establish phone compatibility.

Run `npm run test:fullscreen` for focused Chrome fullscreen checks. These test current and deliberately outdated stylesheets, verify the exit button is hidden before loading, after loading, and after exit, and use pixel checks of all four source edges for large portrait and landscape canvases in native fullscreen, the mobile fallback, and after viewport rotation, plus exit-button and Escape behavior. This simulates phone viewport sizes rather than testing a physical phone.

Fullscreen also sets an explicitly fitted canvas box in JavaScript, updates it on viewport resize, and restores the normal layout on exit. Critical button visibility is set in HTML and JavaScript. The document versions its stylesheet, entry script, and local module imports together so ordinary reloads can request updated assets through cached file relays. When shipping changes, update the shared version in the HTML and module imports together; the vendor bundle is pinned by filename.

Audit regressions additionally inspect decoded pixels and timestamps in actual downloads for a 250 ms dissolve on a 1 fps source and a 10 ms dissolve on a 24 fps source. Controlled promise gates reproduce delayed Play completion during/after export, comparison and settings changes, repeated Play/cancel, and page visibility changes.

Export recovery tests deliberately suspend a decoder mid-export, verify Cancel restores controls, then verify a cached-preview download succeeds without additional decoder reads. Unit tests cover timeout, immediate abort, and sequential-reader sample cleanup. A 10-second 720p H.264/AAC clip with B-frames and a long GOP was also exported successfully during this investigation; that does not reproduce every device-specific codec stall.
