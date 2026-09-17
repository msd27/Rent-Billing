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
- Tapping the current/previous meter image fields opens the native "Take
  Photo / Choose from Gallery" prompt (via `@capacitor/camera`). The QR and
  signature fields use a plain file picker instead (see below for why) —
  it still offers a camera option on Android, just through the system's own
  chooser rather than Capacitor's custom-labelled prompt.
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
- A "Copy" button next to the UPI ID copies it to the clipboard (falls back
  to a hidden-textarea `execCommand("copy")` if the Clipboard API isn't
  available). Excluded from the PDF export.
- "Pay via UPI" (in the PDF preview) opens a `upi://pay` deep link
  pre-filled with the UPI ID, owner name, computed total, and a note —
  Android hands this to whichever UPI apps are installed (Google Pay,
  PhonePe, etc.) as an app chooser. This only works as a live button
  inside the app; it can't be embedded as a clickable
  "app launcher" in the exported PDF file itself, since a flattened image
  in a PDF has nothing to click.
- Meter photo boxes are a fixed, uniform size (both the same, regardless of
  what photo you take) and crop to fill (`object-fit: cover`) rather than
  letterbox. This was tried the other way (each box sizing itself to its
  own photo's aspect ratio) to avoid any cropping, but that made the two
  photos render at different sizes next to each other and threw off the
  spacing around them — a uniform layout with minor edge-cropping reads as
  more correct for a formal invoice than same-but-inconsistently-sized
  photos. Frame the meter reading centered in the shot and the crop won't
  matter.

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
  digits, trying several detectors from strict to loose (`GREEN_DETECTOR_TIERS`
  in `src/app.js`): three RGB brightness/dominance thresholds, then a
  hue-based detector as a final fallback since hue holds up much better
  than raw RGB dominance under the glare/vignette a real LCD photo shows
  (a washed-out, near-white edge still has roughly the right hue even
  though its RGB channels no longer look "green-dominant"). Verified this
  against a synthetic image with a deliberately severe glare gradient —
  correctly isolated the display and read the digits regardless of which
  tier matched. Still a best-effort heuristic — always review the detected
  value. If it still can't find the display on your meter's photos, the
  status line under the field shows diagnostics in the form `Couldn't read
  digits [crop:y/n tier:<name> saw:"..."]` — `crop:n` means detection
  itself failed; `crop:y` with `saw:"(no text found)"` (as seen in a real
  device report) means detection isolated the display correctly but
  Tesseract's recognition step returned nothing — for that specific
  failure mode, switched the cropped-region segmentation mode from
  `PSM.SINGLE_LINE` (strict horizontal-alignment assumption, can return
  totally empty text if a real photo's slight tilt or binarization noise
  doesn't match it exactly) to `PSM.SINGLE_BLOCK` (more tolerant, still
  targeted at one coherent region). Tapping that diagnostic status message
  also opens the exact cropped/binarized image that was handed to
  Tesseract, so screenshotting and sharing *that* — not just the app
  screen — shows precisely what the pipeline saw.
- Meter photo boxes are a fixed, uniform size using `object-fit: cover`
  (see above), so the invoice's overall shape stays stable regardless of
  what photos you take — the exported PDF's page size still matches that
  shape exactly (long edge fixed at 297mm) rather than forcing a fixed A4
  box, so it's always gap-free, but in practice should stay close to a
  normal A4-landscape look now.
- App icon and splash screen are still Capacitor's defaults.
- QR and signature images with a transparent background used to render with
  a solid black fill instead of transparency. Root cause: `@capacitor/camera`
  always re-encodes its result as JPEG (`Bitmap.CompressFormat.JPEG` is
  hardcoded in the plugin's Android source — there's no PNG option), and
  JPEG has no alpha channel, so any transparent pixels get flattened to
  whatever RGB sits beneath them, which for most PNG exports is black. That
  happens natively before the image data ever reaches the web app, so it
  couldn't be fixed with CSS/JS after the fact. Fixed by routing the QR and
  signature fields through a plain `<input type="file">` + `FileReader`
  instead of `Camera.getPhoto`, which reads the original file bytes
  untouched and preserves transparency. Meter photos still use
  `Camera.getPhoto` since they're live camera shots (no transparency
  involved) and benefit from the custom-labelled native prompt.
