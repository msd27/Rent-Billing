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
  (Tesseract.js) crops to just the meter's green LCD display, binarizes it
  for contrast, and reads the digits to pre-fill the reading field — always
  double-check the detected number before relying on it, meter photos
  aren't always read perfectly.
- All form fields and images persist locally (via `@capacitor/preferences`)
  so you don't need to retype everything each billing cycle.
- "Preview PDF" renders the invoice to an image first so you can check it
  before committing to anything; "Save / Share PDF" in that preview then
  builds the actual PDF (jsPDF + html2canvas) and opens the native share
  sheet on Android, or downloads it directly in a browser.

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

- OCR runs fully on-device but Tesseract.js downloads its language/model
  data from a CDN the first time it runs, so the very first OCR attempt
  needs an internet connection; after that it's cached.
- Meter-reading OCR crops to the display's green backlight before reading
  digits, but it's still a best-effort heuristic — always review the
  detected value before generating the bill. If it's consistently wrong on
  your meter's photos, the green-detection thresholds in
  `src/app.js` (`GREEN_MIN_BRIGHTNESS`, `GREEN_MIN_DOMINANCE`) may need
  tuning to your meter's actual backlight color and lighting conditions.
- App icon and splash screen are still Capacitor's defaults.
