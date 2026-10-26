# Virtual Drum Studio Final Draft

This folder is an independent continuation of `Progress_Report/Demo`. The original Demo is not modified.

## Included features

- Procedural Three.js drum kit with real lighting, shadows, perspective, raycasting, hit glow, drumhead movement, cymbal vibration, and impact feedback.
- Hybrid sensor fusion runs dual blue-marker tracking and MediaPipe Hands together rather than as separate modes.
- Blue markers supply only X/Y aiming and drum-zone selection; MediaPipe supplies Z-axis velocity and acceleration. A drum sounds only when a fresh Z impulse and an on-drum blue tip occur within the fusion window.
- Simply moving or leaving a blue marker over a drum no longer triggers sound.
- Each stick has a contact latch: one continuous drum contact can trigger at most once. The tracked blue tip must be visibly outside every drum zone for two consecutive color frames before that stick is re-armed.
- Drum contact is direction-gated at the moment the blue tip enters a drum zone: its motion must be clearly downward and the vertical displacement must dominate the sideways displacement. Side entries, upward entries, cross-drum slides, and markers first acquired inside a drum zone remain silent until lifted clear and struck downward again.
- Dual blue-marker tracking is powered by the Demo's local `tracking-min.js` with a custom blue classifier.
- Temporal two-slot tracking filters blue interference by marker size, shape, motion, continuity, and last-known position; additional blue regions cannot displace locked drumsticks.
- Two live 3D indicators link camera space to the virtual stage: blue drumsticks in color mode and cyan fingertips in MediaPipe mode.
- MediaPipe Hands mode with two-hand landmarks and projected Y/Z velocity strike detection.
- Low-latency Web Audio API playback using the five original Demo samples.
- Spacebar kick input.
- Web MIDI support. General MIDI notes 35/36 trigger the kick; common GM notes also map to snare, tom, hi-hat, and crash.
- Local-only camera processing and fully local Three.js, MediaPipe WASM, and hand model files.
- Responsive, presentation-ready interface with live status, FPS, hit count, latency, and input diagnostics.

## Run locally

From this folder, run:

```powershell
npm start
```

Then open:

```text
http://127.0.0.1:5500/
```

If port 5500 is occupied:

```powershell
node server.mjs 5502
```

Use Chrome or Microsoft Edge. Allow camera access when prompted. Open the laptop's physical camera shutter.

## Controls

- Put similarly sized blue markers on both drumstick tips, then move each briefly so the two tracking slots lock on. Keep both hands visible so MediaPipe can measure each hand's Z-axis strike impulse.
- Press Space for the kick drum.
- Select Connect MIDI pedal to enable a USB MIDI pedal or electronic kit.

## Browser support

Web MIDI is supported in Chromium browsers such as Chrome and Edge. Camera access requires a local HTTP origin; do not open `index.html` directly with a `file:///` URL.
