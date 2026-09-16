# Rent Billing

A rent invoice builder: fill in tenant/meter/rent details, capture meter photos
(with auto-read meter values via on-device OCR), and export an A4 PDF invoice.
Runs as a web page and as an installable Android app (via [Capacitor](https://capacitorjs.com/)),
sharing one codebase.

## Project layout

- `src/` — the source web app (`index.html`, `app.js`, `styles.css`). Edit here.
- `www/` — build output (generated, gitignored). Never edit directly.
- `android/` — the native Android project that wraps `www/`.
- `esbuild.config.js` — bundles `src/app.js` (which imports the Capacitor
  plugins, jsPDF, html2canvas, and Tesseract.js) into `www/app.js`.

## Features

- Same invoice form/fields as the original web version.
- On mobile, the invoice preview is pinned to the top of the screen (scaled
  to fit, no scrolling needed) with the form scrollable below it.
- Focusing a form field lights up the matching section of the invoice with
  a neon border, so it's obvious what you're about to change.
- Tapping any of the 4 image fields (current meter, previous meter, QR,
  signature) opens the native "Take Photo / Choose from Gallery" prompt.
- After capturing the current or previous meter photo, on-device OCR
  (Tesseract.js, fully self-hosted — no CDN calls, works offline) crops to
  just the meter's green LCD display, binarizes it for contrast, and reads
  the digits to pre-fill the reading field — always double-check the
  detected number before relying on it, meter photos aren't always read
  perfectly.
- All form fields and images persist locally (via `@capacitor/preferences`)
  so you don't need to retype everything each billing cycle.
- "Preview PDF" renders the invoice to an image first so you can check it
  before committing to anything; "Save / Share PDF" in that preview then
  builds the actual PDF (jsPDF + html2canvas) and opens the native share
  sheet on Android, or downloads it directly in a browser.
- "Pay via UPI" (next to the QR code, and in the PDF preview) opens a
  `upi://pay` deep link pre-filled with the UPI ID, owner name, computed
  total, and a note — Android hands this to whichever UPI apps are
  installed (Google Pay, PhonePe, etc.) as an app chooser. This only works
  as a live button inside the app; it can't be embedded as a clickable
  "app launcher" in the exported PDF file itself, since a flattened image
  in a PDF has nothing to click.
- Meter photo boxes size themselves to match each captured photo's own
  aspect ratio, so photos always show completely with no cropping and no
  empty letterbox gaps, whatever orientation they were taken in.

## Working on the web app only

```bash
npm install
npm run build      # bundles src/ -> www/
npx serve www       # or: python3 -m http.server 8080 --directory www
```

Open the served URL in a browser. Camera capture falls back to the browser's
own file picker; OCR and PDF export work the same as in the app.

## Building/running the Android app

Requires [Android Studio](https://developer.android.com/studio) (which
includes the Android SDK) installed locally — this repo's dev container has
no Android SDK, so the app can only be scaffolded here, not compiled or run.

```bash
npm install
npm run android     # builds www/, syncs it into android/, opens Android Studio
```

In Android Studio: let Gradle sync finish, then press Run to install on an
emulator or a USB-connected device.

If you change anything under `src/`, re-run `npm run sync` (or `npm run
android`) to rebuild and copy the changes into the native project before
running again.

## Releasing to the Play Store (when ready)

1. In `capacitor.config.json`, `appId` is `com.monoranjan.rentbilling` —
   change this now if you want a different package name; it cannot be
   changed after your first Play Store release.
2. In Android Studio: **Build > Generate Signed App Bundle**, create a
   signing key (back it up — losing it means you can't update the app
   again), and build a release `.aab`.
3. Create an app listing in the
   [Google Play Console](https://play.google.com/console) and upload the
   `.aab`. You'll need a privacy policy covering camera/photo usage, since
   the app requests camera access.
4. Update the app icon/splash screen (currently Capacitor's default) via
   Android Studio's Image Asset tool before your first release.

## Known limitations / next steps

- OCR's worker script, WASM core, and English language data are all bundled
  locally under `www/tesseract/` (copied from `node_modules` by
  `esbuild.config.js`) instead of fetched from a CDN, so it works fully
  offline with no network dependency. If OCR ever hangs or times out
  (25s), check Android Studio's Logcat for the actual error rather than
  assuming it's a network issue.
- Meter-reading OCR crops to the display's green backlight before reading
  digits (trying a few brightness/color-dominance thresholds from strict to
  loose, since real photos vary a lot more than a lab test image), but it's
  still a best-effort heuristic — always review the detected value before
  generating the bill. If it still can't find the display on your meter's
  photos, the status line under the field now shows diagnostic info in the
  form `Couldn't read digits [crop:y/n saw:"..."]` — `crop:n` means the
  green-display detection itself failed (tune `GREEN_THRESHOLD_TIERS` /
  `GREEN_MIN_AREA_FRACTION` in `src/app.js`); `crop:y` with garbled `saw:`
  text means detection worked but OCR misread the digits. Either way,
  include that diagnostic text (or better, the actual photo) in a bug
  report — tuning blind against a screenshot hasn't been reliable.
- Photo boxes clamp their aspect ratio to a 0.6–1.8 range (`PHOTO_ASPECT_MIN`/
  `PHOTO_ASPECT_MAX` in `src/app.js`) so one extreme portrait/landscape photo
  doesn't distort the whole invoice's shape too far; within that range
  photos still show with zero cropping and zero letterboxing. The exported
  PDF's page size always matches the invoice's actual rendered shape
  (long edge fixed at 297mm) rather than forcing a fixed A4 box, so it
  never has empty margins — but if your photos push the invoice noticeably
  off a landscape shape, the PDF page won't look like traditional A4
  landscape anymore, just gap-free.
- App icon and splash screen are still Capacitor's defaults.
