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

- Same invoice form/fields as the original web version, plus an "Other
  charges reason" text field (`#otherChargesReason`, right after "Other
  charges") that had been missed when this app was built — it's a plain
  optional text field, persisted/highlighted like every other field via
  `fields`/`fieldHighlightTargets` in `src/app.js`. When filled in, it's
  appended in parentheses after the Other charges amount on the invoice
  (`Other charges (অন্য খৰচ) = 0 (repair charge)`); left empty, it adds
  nothing.
- A "Deduction reason" text field (`#deductionReason`, right after
  "Deduction") replaces what used to be a hardcoded
  "(tuition room fan charge)" label on the invoice regardless of what the
  deduction actually was. Same pattern as "Other charges reason": appended
  in parentheses after the deduction amount when filled in
  (`= 3,000 + 288-15 (late fee)`), omitted entirely when empty.
- A "Refresh" button in the top-right of the header (`#refreshBtn`,
  `resetForNewInvoice()` in `src/app.js`) clears everything specific to
  one invoice — room, tenant, billing month, readings, rate, rent,
  deduction + its reason, other charges + its reason, both meter dates,
  and the current/previous meter photos — for starting the next tenant/month
  without re-typing from scratch. It deliberately leaves Address, UPI ID,
  the payment QR image, and the owner's signature image alone: those
  belong to the landlord, rarely change, and are only ever updated
  manually via their own "Add photo" buttons or by editing the address
  text directly — a refresh should never silently wipe them. Cleared text
  fields fall back to a placeholder naming the field (e.g. "Room",
  "Tenant name") so it's obvious what belongs there; cleared photos
  revert to their normal "Add current/previous meter image" placeholder.
  The action asks for confirmation first since it can't be undone.
- The Payment QR and Owner signature "Add photo" buttons are gated behind
  a PIN (`verifyPin()`/`showPinOverlay()` in `src/app.js`, `#pinOverlay`)
  — the meter photo buttons are unaffected. This is a soft deterrent
  against an accidental tap changing them, not real security: the whole
  app is client-side with no server, so the PIN lives in this device's
  own Preferences alongside everything else, same as the rest of the
  app's data. The first time either button is tapped, the app asks you to
  set a PIN instead of entering one; every later tap asks for that PIN.
  A "Forgot PIN?" link resets it on the spot (after a plain confirm — no
  email or phone verification, since there's no backend to send one
  through) and immediately asks you to set a new one, so a forgotten PIN
  can never lock you out of your own signature/QR. The PIN is set
  independently on every device/install — it is not synced or shared, and
  a fresh install starts with no PIN (and no signature/QR image) until
  one is set on that device.
- The screen is three top-level pieces stacked in `.app-shell`, not two:
  `.app-header` (logo + "Rent Billing"/"Invoice Builder") pinned at the
  very top, then the invoice preview, then the form panel — the brand
  header used to live inside the form panel itself, below the preview,
  which didn't read as a page-level header. On mobile this is plain
  `order` in a column flex layout (`.app-header` at `order:-2`, the
  preview at `-1`); on desktop `.app-shell` is a grid with `.app-header`
  spanning both columns in its own row above the form/preview columns.
- On mobile, the invoice preview is pinned below the app header (scaled
  to fit, no scrolling needed) with the form scrollable below it. Its
  size is locked to the viewport height at load/orientation-change time
  (see `lockViewportHeight` in `src/app.js`), not a live `dvh` unit, so
  opening the on-screen keyboard to edit a field doesn't shrink it —
  only a real width change (rotating the device) re-fits it.
- The form panel is two plain flex siblings inside `.controls` around
  the scrolling fields: `.control-footer` (the "Preview PDF" button)
  fixed at the bottom, mirroring a typical native app's bottom action
  bar. It's a structural sibling outside the scrolling region, not
  `position: sticky` on an element inside it — the app header above had
  the same issue when it briefly lived inside the form panel: a
  real-device test showed sticky positioning didn't reliably mask
  fields scrolling underneath a sticky bar (some WebView versions handle
  sticky inconsistently in a nested flex/overflow context), so field
  text was visibly poking out above it. Keeping bars structurally
  outside the scroll container's DOM avoids that whole class of bug.
- Without `android:windowSoftInputMode="adjustResize"` on `MainActivity`
  (`android/app/src/main/AndroidManifest.xml`), Android's default is to
  *pan* the window up over the keyboard instead of resizing the WebView,
  which made the fixed "Preview PDF" bar slide up and land on top of
  whatever field the user was editing (worst on the last field, "Previous
  meter date", with nothing below it to scroll past). `adjustResize`
  makes the WebView's own height actually shrink by the keyboard's
  height, so the CSS `100dvh` shell shrinks with it, `.control-fields`'s
  scrollable area shrinks to match, and `.control-footer` stays pinned at
  the (now-smaller) bottom of `.controls` — visible above the keyboard,
  never over a field. That resize alone wasn't enough, though: the
  invoice preview's own height stays locked to the *pre-keyboard* full
  screen height (deliberately, so it doesn't shrink/jump mid-edit — see
  above), so once the keyboard actually eats real space, the fixed-height
  header + preview left too little room for the form. `updateKeyboardState`
  in `src/app.js` detects the shrink (via `visualViewport`, comparing
  against the locked `--app-vh`) and toggles a `keyboard-open` class on
  `<html>`. Rather than shrinking the preview by an arbitrary fixed
  amount, `sizePreviewForKeyboard()` measures the real rendered height of
  one form field (`.control-fields label`) and reserves room for two of
  them (so the field being edited plus the next one for context are
  always visible), then sets `--keyboard-preview-height` to whatever's
  left over for the preview — clamped so it never goes below a small
  floor or above its normal size. `fitInvoiceToViewport()` re-runs right
  after so the invoice rescales down to that height instead of getting
  clipped — it stays visible, just smaller, sized to fit whatever room
  the keyboard left. It returns to full size as soon as the keyboard
  closes.
- The meter-date captions in the invoice itself (under the current/
  previous meter photos, `.meter-card figcaption`) are set to a larger,
  bolder font (19px/700, up from 13px) since they're easy to misread at
  the default size. The form's own date inputs are unchanged.
- Form fields have a tinted background and a soft inset shadow instead of
  a flat white box, and the four "Add photo" buttons are filled with a
  teal gradient (`.add-photo-btn`, layered on `.secondary-btn`) rather
  than the plain outline used by the modal's Close/Pay buttons that also
  share `.secondary-btn`. The form panel itself has a subtle paper-grain
  texture (an inline SVG `feTurbulence` noise filter, base64-encoded
  directly into the CSS `background-image` — no image asset to bundle)
  instead of a flat panel color.
- That same paper-grain fill (flat color + noise image, shared via the
  `--paper-bg-color`/`--paper-bg-image` custom properties) is also used
  on `.app-header` and `body`, so the header bar and the page background
  around the invoice preview read as one continuous surface with the form
  panel — only the invoice itself (`.invoice`, always plain white) stands
  out from it.
- Focusing a form field lights up the matching section of the invoice with
  a neon border, so it's obvious what you're about to change. The
  highlight targets an inner wrapper sized to the actual title text
  (`.invoice-title-inner`), not the `.invoice-title` container itself —
  that container reserves 230px of padding for the payment box next to
  it, and highlighting it directly used to stretch the glow box straight
  across underneath the QR code.
- The app's house-in-a-tag logo is pinned to the invoice's own top-left
  corner at 90px (`.invoice-logo-badge`), next to a bolder, letter-spaced
  "INVOICE" heading.
- The meter photo boxes, QR box, billing table, and address box all carry
  a soft drop shadow for a raised "card" look instead of flat borders.
- The meter and signature photos use `object-fit: cover` (crop to fill the
  box) but the QR image uses `object-fit: contain` instead
  (`.qr-placeholder img` in `src/styles.css`) — cropping a QR code to fill
  a fixed box can cut off its corner finder patterns and make it
  unscannable, so it's shown exactly as uploaded (letterboxed, never
  cropped) rather than filled like the other photos.
- All four "Add photo" buttons (current/previous meter image, QR,
  signature) open the same in-app "Take photo / Choose from gallery"
  sheet (`#imageSourceOverlay`) — gallery goes through a plain file input
  (see below for why: it preserves PNG transparency), camera goes through
  `Camera.getPhoto` with `source: CameraSource.Camera` specifically. The
  meter photos used to go through Capacitor's own `Camera.getPhoto(source:
  CameraSource.Prompt)` dialog instead, on the assumption that native
  prompt would reliably offer both options — same wrong assumption as the
  single OS file-input chooser tried even earlier, confirmed missing a
  camera option on a real device. All four fields now share one explicit,
  known-working path instead of each field trusting a different picker.
  OCR for the meter fields (`ocrTargetId`) runs from this same shared
  `storePickedImage()` path now, whichever of the two ways the photo came
  in.
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
- A small "Thank you for staying with us." note at the very bottom of the
  invoice, below the signature. The `------******------` cut-line sits
  directly above it (moved below the signature block, which used to come
  after the cut-line instead).
- A "Copy" button next to the UPI ID copies it to the clipboard (falls back
  to a hidden-textarea `execCommand("copy")` if the Clipboard API isn't
  available). Excluded from the PDF export. The UPI ID and the button sit
  on one line — the ID truncates with an ellipsis if it doesn't fit rather
  than wrapping the button to its own line; copying still uses the full
  underlying value, not the truncated display text.
- The billing table and address box have rounded corners. The table uses
  `border-collapse: collapse`, which doesn't reliably support
  `border-radius` directly (the collapsed cell borders bypass the table's
  own box-model rounding in most browsers) — it's wrapped in a
  `.bill-table-wrap` with `overflow: hidden` instead, the standard
  workaround.
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
- That debug image is what exposed a real bug: `binarizeDisplayCanvas`
  used to decide black-vs-white for every pixel by reusing the *same*
  "is this green" test used to locate the display — a shortcut that only
  happens to work for a real green-backlit LCD. Fed a plain black-on-white
  reference image (or any photo with enough compression noise to trip the
  loose hue tier), that test has no relationship to "is this a digit or
  the background", so it produced near-random per-pixel noise — a mostly
  solid black image with scattered white flecks, not a clean binarized
  one. Fixed by replacing it with proper Otsu-threshold binarization
  (`computeOtsuThreshold` in `src/app.js`): it finds the actual brightness
  split in *that* image's own luminance histogram, then maps whichever
  side covers fewer pixels (the digit strokes are always the minority of
  a display's area) to black and the rest to white — correct regardless
  of the display's real colors. The green/hue tiers are still used to
  *locate* the display region in a full photo; only the flawed black/white
  decision afterward changed.
- Meter photo boxes are a fixed, uniform size using `object-fit: cover`
  (see above), so the invoice's overall shape stays stable regardless of
  what photos you take — the exported PDF's page size still matches that
  shape exactly (long edge fixed at 297mm) rather than forcing a fixed A4
  box, so it's always gap-free, but in practice should stay close to a
  normal A4-landscape look now.
- App icon is a house-in-a-tag mark (blue `#0075BE`), generated at every
  required density under `android/app/src/main/res/mipmap-*/` — the legacy
  `ic_launcher(.round).png` carries the full tag shape, and the adaptive
  icon's foreground (`ic_launcher_foreground.png`, just the house/ring on
  transparent) sits over a flat blue background
  (`values/ic_launcher_background.xml`) so it isn't clipped oddly by
  circular/squircle launcher masks. The same mark appears as a small badge
  next to "Rent Billing" in the web header (`.brand-logo`) and again, at
  90px, pinned to the invoice's own top-left corner
  (`.invoice-logo-badge`), both in `src/index.html`. Splash screen is
  still Capacitor's default.
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
  That fix turned out to be necessary but not sufficient: the PDF preview
  and export both flatten the whole invoice to a JPEG
  (`canvas.toDataURL("image/jpeg", …)`), which drops alpha the same way —
  so any transparency that survived image capture still turned black the
  moment you tapped "Preview PDF". Fixed properly by compositing every
  picked QR/signature image onto an opaque white background ourselves,
  right when the file is read (`compositeOntoWhite` in `src/app.js`),
  instead of trying to keep transparency alive through every later step —
  by the time the image is stored, there's no alpha channel left for
  anything downstream to lose. One more wrinkle: a signature/QR image
  saved from *before* this fix is a JPEG (from the old `Camera.getPhoto`
  path) with the black already baked in permanently — reloading the app
  kept redisplaying that stale, already-broken image no matter how
  correct the new capture code was, since it never got a chance to run
  again. Fixed by detecting that case on load (any stored image value
  that's a `data:image/jpeg`) and discarding it back to the
  empty placeholder instead, so the next photo you add actually goes
  through the fixed path. If you've hit this bug before, you'll need to
  re-add the QR/signature photo once after updating — it won't fix
  itself retroactively.
