import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { createWorker, PSM, OEM } from "tesseract.js";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

const fields = [
  "room",
  "tenant",
  "billingMonth",
  "upi",
  "address",
  "currentReading",
  "previousReading",
  "rate",
  "rent",
  "deduction",
  "otherCharges",
  "currentDate",
  "previousDate",
];

const images = [
  { inputId: "currentImage", previewId: "currentImagePreview", ocrTargetId: "currentReading" },
  { inputId: "previousImage", previewId: "previousImagePreview", ocrTargetId: "previousReading" },
  { inputId: "qrImage", previewId: "qrPreview", ocrTargetId: null, useFilePicker: true },
  { inputId: "signatureImage", previewId: "signaturePreview", ocrTargetId: null, useFilePicker: true },
];

const fieldHighlightTargets = {
  room: ["title"],
  tenant: ["title"],
  billingMonth: ["title"],
  upi: ["payment"],
  address: ["address"],
  currentReading: ["row-units"],
  previousReading: ["row-units"],
  rate: ["row-energy"],
  rent: ["row-rent", "row-total"],
  deduction: ["row-total"],
  otherCharges: ["row-total", "row-other"],
  currentDate: ["photo-current"],
  previousDate: ["photo-previous"],
};

const money = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

let generatedAt = "";
let ocrWorker = null;

function fieldKey(id) {
  return `rent-billing-field-${id}`;
}

function imageKey(inputId) {
  return `rent-billing-${inputId}`;
}

function refreshGeneratedAt() {
  generatedAt = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
  setOutput("generatedAt", generatedAt);
}

function numericValue(id) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : 0;
}

function setOutput(name, value) {
  document.querySelectorAll(`[data-out="${name}"]`).forEach((node) => {
    node.textContent = value;
  });
}

function computeTotals() {
  const currentReading = numericValue("currentReading");
  const previousReading = numericValue("previousReading");
  const rate = numericValue("rate");
  const rent = numericValue("rent");
  const deduction = numericValue("deduction");
  const otherCharges = numericValue("otherCharges");
  const units = Math.max(currentReading - previousReading, 0);
  const energyCharge = units * rate;
  const total = rent + energyCharge - deduction + otherCharges;

  return { units, energyCharge, rent, deduction, otherCharges, total };
}

function renderInvoice() {
  fields.forEach((id) => setOutput(id, document.getElementById(id).value));
  setOutput("generatedAt", generatedAt);

  const { units, energyCharge, rent, deduction, otherCharges, total } = computeTotals();

  setOutput("units", money.format(units));
  setOutput("energyCharge", money.format(energyCharge));
  setOutput("rent", money.format(rent));
  setOutput("otherCharges", money.format(otherCharges));
  setOutput("total", money.format(total));
  setOutput("deductionFormula", deduction ? `-${money.format(deduction)}(tuition room fan charge)` : "");
  setOutput("otherFormula", otherCharges ? ` + ${money.format(otherCharges)}(other charges)` : "");
}

async function loadSavedFields() {
  await Promise.all(
    fields.map(async (id) => {
      const { value } = await Preferences.get({ key: fieldKey(id) });
      if (value !== null && value !== undefined) {
        document.getElementById(id).value = value;
      }
    }),
  );
}

function highlightTargetsFor(id) {
  const groups = fieldHighlightTargets[id];
  if (!groups || groups.length === 0) {
    return [];
  }
  const selector = groups.map((key) => `[data-highlight="${key}"]`).join(",");
  return document.querySelectorAll(selector);
}

function attachFieldPersistence() {
  fields.forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      renderInvoice();
      Preferences.set({ key: fieldKey(id), value: el.value });
    });
    el.addEventListener("focus", () => {
      highlightTargetsFor(id).forEach((node) => node.classList.add("neon-highlight"));
    });
    el.addEventListener("blur", () => {
      highlightTargetsFor(id).forEach((node) => node.classList.remove("neon-highlight"));
    });
  });
}

function setPreviewImage(preview, inputId, source) {
  preview.innerHTML = "";
  const image = document.createElement("img");
  image.alt = inputId.replace("Image", " meter image");
  image.src = source;
  preview.appendChild(image);
}

const OCR_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getOcrWorker() {
  if (!ocrWorker) {
    const workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: "/tesseract/worker.min.js",
      corePath: "/tesseract/tesseract-core-lstm.wasm.js",
      langPath: "/tesseract/lang-data",
      workerBlobURL: false,
    });
    ocrWorker = await withTimeout(workerPromise, OCR_TIMEOUT_MS, "Timed out starting the OCR engine");
    await ocrWorker.setParameters({
      tessedit_char_whitelist: "0123456789",
    });
  }
  return ocrWorker;
}

function extractReadingFromText(text) {
  const matches = text.match(/\d{2,6}/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches.reduce((longest, current) => (current.length > longest.length ? current : longest));
}

const GREEN_MIN_PIXELS = 120;
// The display only fills a small fraction of a full, un-zoomed high-res
// camera photo (unlike the tightly-framed synthetic test), so this must
// stay low relative to the whole frame.
const GREEN_MIN_AREA_FRACTION = 0.004;
const GREEN_CROP_PADDING_X = 0.06;
const GREEN_CROP_PADDING_Y = 0.15;
const GREEN_CROP_UPSCALE = 3;

function isDisplayGreenRgb(r, g, b, minBrightness, minDominance) {
  return g > minBrightness && g - r > minDominance && g - b > minDominance;
}

// Hue is far more stable than raw RGB dominance across the brightness
// gradient a real LCD photo shows (glare/vignette washing pixels toward
// white near the edges, deeper green in the center) — RGB dominance
// degrades as a pixel approaches white because all channels rise together.
function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta > 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === rn) {
      hue = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      hue = (bn - rn) / delta + 2;
    } else {
      hue = (rn - gn) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return { hue, saturation, lightness };
}

function isDisplayGreenHue(r, g, b) {
  const { hue, saturation, lightness } = rgbToHsl(r, g, b);
  return hue >= 60 && hue <= 180 && saturation >= 0.15 && lightness >= 0.12 && lightness <= 0.95;
}

// Tried strict-to-loose: a real camera photo's lighting/glare/white-balance
// varies far more than the small flat-color synthetic image these were
// first tuned against. The RGB tiers are fast and precise for well-lit,
// evenly-exposed displays; the final hue-based tier is the fallback for
// glare/vignette that washes some of the display toward white.
const GREEN_DETECTOR_TIERS = [
  { name: "rgb-strict", test: (r, g, b) => isDisplayGreenRgb(r, g, b, 90, 30) },
  { name: "rgb-loose", test: (r, g, b) => isDisplayGreenRgb(r, g, b, 70, 20) },
  { name: "rgb-very-loose", test: (r, g, b) => isDisplayGreenRgb(r, g, b, 50, 12) },
  { name: "hue", test: isDisplayGreenHue },
];

function findGreenBoundingBox(imageData, test) {
  const { data, width, height } = imageData;
  const step = 2;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (test(data[i], data[i + 1], data[i + 2])) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const regionWidth = maxX - minX;
  const regionHeight = maxY - minY;
  const hasEnoughSignal =
    count >= GREEN_MIN_PIXELS &&
    regionWidth > 0 &&
    regionHeight > 0 &&
    (regionWidth * regionHeight) / (width * height) >= GREEN_MIN_AREA_FRACTION;

  return hasEnoughSignal ? { minX, minY, maxX, maxY, regionWidth, regionHeight } : null;
}

function binarizeDisplayCanvas(canvas, test) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let i = 0; i < data.length; i += 4) {
    const isBacklight = test(data[i], data[i + 1], data[i + 2]);
    const value = isBacklight ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }

  ctx.putImageData(imageData, 0, 0);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function cropToDisplayRegion(dataUrl) {
  let img;
  try {
    img = await loadImage(dataUrl);
  } catch {
    return { dataUrl, cropped: false };
  }

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return { dataUrl, cropped: false };
  }

  const { width, height } = imageData;
  let region = null;
  let usedTier = GREEN_DETECTOR_TIERS[0];
  for (const tier of GREEN_DETECTOR_TIERS) {
    region = findGreenBoundingBox(imageData, tier.test);
    if (region) {
      usedTier = tier;
      break;
    }
  }

  if (!region) {
    return { dataUrl, cropped: false, tier: null };
  }

  const { minX, minY, regionWidth, regionHeight } = region;
  const padX = regionWidth * GREEN_CROP_PADDING_X;
  const padY = regionHeight * GREEN_CROP_PADDING_Y;
  const cropX = Math.max(0, minX - padX);
  const cropY = Math.max(0, minY - padY);
  const cropW = Math.min(width - cropX, regionWidth + padX * 2);
  const cropH = Math.min(height - cropY, regionHeight + padY * 2);

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropW * GREEN_CROP_UPSCALE;
  cropCanvas.height = cropH * GREEN_CROP_UPSCALE;
  const cropCtx = cropCanvas.getContext("2d");
  cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropCanvas.width, cropCanvas.height);
  binarizeDisplayCanvas(cropCanvas, usedTier.test);

  return { dataUrl: cropCanvas.toDataURL("image/png"), cropped: true, tier: usedTier.name };
}

async function runOcr(dataUrl, targetId) {
  const status = document.getElementById(`${targetId}OcrStatus`);
  if (status) {
    status.textContent = "Reading meter photo…";
  }

  try {
    const { dataUrl: displayDataUrl, cropped, tier } = await cropToDisplayRegion(dataUrl);
    const worker = await getOcrWorker();
    await worker.setParameters({
      // SINGLE_LINE requires strict horizontal alignment and returns
      // nothing at all if a real photo's slight tilt or binarization
      // noise doesn't match that assumption exactly (confirmed: a real
      // device report showed crop succeeding but recognize() returning
      // empty text). SINGLE_BLOCK tolerates that while still being
      // targeted at "one coherent region", instead of scanning the
      // whole page like SPARSE_TEXT.
      tessedit_pageseg_mode: cropped ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT,
    });
    const {
      data: { text },
    } = await withTimeout(worker.recognize(displayDataUrl), OCR_TIMEOUT_MS, "Timed out reading the photo");
    const reading = extractReadingFromText(text);

    if (reading !== null) {
      const input = document.getElementById(targetId);
      input.value = reading;
      renderInvoice();
      Preferences.set({ key: fieldKey(targetId), value: input.value });
      if (status) {
        status.textContent = `Detected ${reading} — please verify`;
        status.style.cursor = "";
        status.onclick = null;
      }
    } else if (status) {
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 40) || "(no text found)";
      const tierInfo = cropped ? `tier:${tier} ` : "";
      status.textContent = `Couldn't read digits [crop:${cropped ? "y" : "n"} ${tierInfo}saw:"${snippet}"] — tap to view processed image`;
      status.style.cursor = "pointer";
      status.onclick = () => openOcrDebugImage(displayDataUrl);
    }
  } catch (error) {
    console.error("OCR failed", error);
    if (status) {
      const reason = error && error.message ? error.message : "OCR failed";
      status.textContent = `${reason} — please enter manually`;
    }
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function compositeOntoWhite(dataUrl) {
  // Flatten any transparency onto an opaque white background ourselves,
  // right when the file is picked. This is deliberately independent of
  // *why* a transparent pixel might otherwise turn black downstream —
  // whether that's a native re-encode dropping the alpha channel, or the
  // PDF export's own canvas.toDataURL("image/jpeg") doing the same to
  // whatever transparency is still there when it captures the invoice —
  // by the time this image is stored, it has no alpha left to lose.
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Failed to load picked image"));
    image.src = dataUrl;
  });
}

let pendingImagePickerField = null;

function openImageSourceSheet(field) {
  pendingImagePickerField = field;
  document.getElementById("imageSourceOverlay").hidden = false;
}

function closeImageSourceSheet() {
  pendingImagePickerField = null;
  document.getElementById("imageSourceOverlay").hidden = true;
}

async function storePickedImage(field, dataUrl) {
  const flattened = await compositeOntoWhite(dataUrl);
  setPreviewImage(field.preview, field.inputId, flattened);
  await Preferences.set({ key: imageKey(field.inputId), value: flattened });
}

function attachImageCapture({ inputId, previewId, ocrTargetId, useFilePicker }) {
  const button = document.getElementById(`${inputId}Btn`);
  const preview = document.getElementById(previewId);

  Preferences.get({ key: imageKey(inputId) }).then(({ value }) => {
    if (!value) {
      return;
    }
    // A QR/signature image saved before this field switched from
    // Camera.getPhoto to a file picker was captured through the old,
    // lossy JPEG re-encode path — any transparency in it was already
    // flattened to black before it was ever stored, so there's nothing
    // left to fix by loading it. Discard it instead of redisplaying a
    // black box on every app open; the placeholder prompts a fresh pick.
    if (useFilePicker && value.startsWith("data:image/jpeg")) {
      Preferences.remove({ key: imageKey(inputId) });
      return;
    }
    setPreviewImage(preview, inputId, value);
  });

  if (useFilePicker) {
    // QR/signature images are often pre-made graphics with transparency
    // (e.g. a signature exported as a PNG with a transparent background).
    // Capacitor's Camera plugin always re-encodes its result as JPEG
    // (Bitmap.CompressFormat.JPEG, hardcoded natively, no PNG option) —
    // JPEG has no alpha channel, so any transparent pixels get flattened
    // to whatever RGB value sits beneath them, which is black for most
    // PNGs. Picking through a plain file input reads the original file
    // bytes untouched, so transparency survives.
    //
    // The OS's default file-input chooser doesn't reliably offer a
    // "Camera" option on every device (confirmed missing on a real one),
    // unlike Capacitor's own Camera.getPhoto(source: Prompt) dialog used
    // for the meter photos below — so this field gets its own small
    // "Take photo / Choose from gallery" sheet (#imageSourceOverlay)
    // instead of relying on either single picker alone: gallery goes
    // through this file input (transparency-safe), camera goes through
    // Camera.getPhoto with source: Camera specifically (a live photo
    // never has transparency to lose in the first place).
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.hidden = true;
    document.body.appendChild(fileInput);

    const field = { inputId, preview, fileInput };

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) {
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        await storePickedImage(field, dataUrl);
      } catch (error) {
        console.error("Image selection failed", error);
      }
    });

    button.addEventListener("click", () => openImageSourceSheet(field));
    return;
  }

  button.addEventListener("click", async () => {
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Prompt,
        quality: 80,
        promptLabelHeader: "Add photo",
        promptLabelPhoto: "Choose from gallery",
        promptLabelPicture: "Take photo",
      });

      setPreviewImage(preview, inputId, photo.dataUrl);
      await Preferences.set({ key: imageKey(inputId), value: photo.dataUrl });

      if (ocrTargetId) {
        runOcr(photo.dataUrl, ocrTargetId);
      }
    } catch (error) {
      if (error && error.message === "User cancelled photos app") {
        return;
      }
      console.error("Photo capture failed", error);
    }
  });
}

function lockViewportHeight() {
  // Android resizes the WebView's visual viewport when the on-screen
  // keyboard opens, which made `dvh`-based heights (and the scale computed
  // from them) shrink the pinned invoice preview mid-edit. Capture the
  // *real* viewport height into a CSS variable only when the width also
  // changes (an actual layout change), so the keyboard opening/closing
  // can't feed back into it.
  document.documentElement.style.setProperty("--app-vh", `${window.innerHeight}px`);
}

function updateKeyboardState() {
  // With windowSoftInputMode="adjustResize", the WebView's own height
  // (window.innerHeight / visualViewport.height) genuinely shrinks by the
  // keyboard's height instead of the page being panned over it. The
  // invoice preview above keeps its *pre-keyboard* height (locked by
  // lockViewportHeight, deliberately not live) so it doesn't jump around
  // while typing — but that means when the keyboard actually eats real
  // space, the fixed-height header + preview no longer leave enough room
  // for the scrollable form. Detecting the keyboard and shrinking the
  // preview (a plain class toggle to a much smaller fixed height, plus a
  // rescale) hands most of that space back to the form while keeping the
  // invoice visible rather than hiding it outright.
  if (window.innerWidth > 1100) {
    const wasOpen = document.documentElement.classList.contains("keyboard-open");
    document.documentElement.classList.remove("keyboard-open");
    if (wasOpen) {
      fitInvoiceToViewport();
    }
    return;
  }
  const fullHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-vh")) || window.innerHeight;
  const currentHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const keyboardOpen = fullHeight - currentHeight > 120;
  const wasOpen = document.documentElement.classList.contains("keyboard-open");
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  if (keyboardOpen !== wasOpen) {
    fitInvoiceToViewport();
  }
}

function fitInvoiceToViewport() {
  const wrap = document.querySelector(".preview-wrap");
  const invoice = document.getElementById("invoice");
  const naturalWidth = 1123;

  invoice.style.transform = "";
  invoice.style.marginLeft = "";
  invoice.style.marginRight = "";

  if (window.innerWidth > 900) {
    return;
  }

  // Flexbox/margin:auto centering positions elements using their
  // *unscaled* layout size, not the visually-scaled result of a CSS
  // transform — with a 1123px-wide, very tall layout box scaled down to
  // fit a small mobile pane, that mismatch pushed the scaled invoice
  // almost entirely out of view. Anchor the transform at top-left and
  // compute the centering offset from the scaled size directly instead.
  const naturalHeight = invoice.offsetHeight;
  const availableWidth = wrap.clientWidth - 24;
  const availableHeight = wrap.clientHeight - 24;
  const scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);

  invoice.style.transformOrigin = "top left";
  invoice.style.transform = `scale(${scale})`;

  const scaledWidth = naturalWidth * scale;
  const horizontalMargin = Math.max(0, (availableWidth - scaledWidth) / 2);
  invoice.style.marginLeft = `${horizontalMargin}px`;
  invoice.style.marginRight = "0";
}

let pendingCanvas = null;

async function renderInvoiceCanvas() {
  const invoice = document.getElementById("invoice");
  const previousTransform = invoice.style.transform;
  const previousMarginLeft = invoice.style.marginLeft;
  const previousMarginRight = invoice.style.marginRight;
  invoice.style.transform = "";
  invoice.style.marginLeft = "";
  invoice.style.marginRight = "";

  try {
    refreshGeneratedAt();
    renderInvoice();
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    return await html2canvas(invoice, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      ignoreElements: (el) => el.id === "copyUpiBtn",
    });
  } finally {
    invoice.style.transform = previousTransform;
    invoice.style.marginLeft = previousMarginLeft;
    invoice.style.marginRight = previousMarginRight;
  }
}

async function buildAndSharePdf(canvas) {
  const imgData = canvas.toDataURL("image/jpeg", 0.92);

  // Size the page to the invoice's own aspect ratio (long edge fixed at
  // A4's 297mm) instead of forcing it into a fixed A4 box, which left
  // gaps on the sides whenever the captured content's proportions
  // (variable now that photo boxes match each photo's own aspect ratio)
  // didn't match A4 landscape exactly.
  const aspect = canvas.width / canvas.height;
  const isLandscape = aspect >= 1;
  const longEdgeMm = 297;
  const pageWidth = isLandscape ? longEdgeMm : longEdgeMm * aspect;
  const pageHeight = isLandscape ? longEdgeMm / aspect : longEdgeMm;

  const pdf = new jsPDF({
    orientation: isLandscape ? "landscape" : "portrait",
    unit: "mm",
    format: [pageWidth, pageHeight],
  });

  pdf.addImage(imgData, "JPEG", 0, 0, pageWidth, pageHeight);

  const room = document.getElementById("room").value || "invoice";
  const month = document.getElementById("billingMonth").value || "";
  const fileName = `${room}-${month}`.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "") + ".pdf";

  if (Capacitor.isNativePlatform()) {
    const base64 = pdf.output("datauristring").split(",")[1];
    await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
    await Share.share({ title: "Rent Invoice", url: uri });
  } else {
    pdf.save(fileName);
  }
}

async function openPdfPreview() {
  const printBtn = document.getElementById("printBtn");
  printBtn.disabled = true;
  printBtn.textContent = "Generating…";

  try {
    pendingCanvas = await renderInvoiceCanvas();
    document.getElementById("pdfPreviewImage").src = pendingCanvas.toDataURL("image/jpeg", 0.92);
    document.getElementById("pdfPreviewOverlay").hidden = false;
  } catch (error) {
    console.error("Failed to render invoice preview", error);
  } finally {
    printBtn.disabled = false;
    printBtn.textContent = "Preview PDF";
  }
}

function closePdfPreview() {
  document.getElementById("pdfPreviewOverlay").hidden = true;
}

async function confirmPdfExport() {
  if (!pendingCanvas) {
    return;
  }
  const confirmBtn = document.getElementById("pdfPreviewConfirm");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Saving…";

  try {
    await buildAndSharePdf(pendingCanvas);
    closePdfPreview();
  } catch (error) {
    console.error("PDF export failed", error);
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Save / Share PDF";
  }
}

function payWithUpi() {
  const upiId = document.getElementById("upi").value.trim();
  if (!upiId) {
    return;
  }

  const ownerNameEl = document.querySelector(".signature-block strong");
  const payeeName = ownerNameEl ? ownerNameEl.textContent.trim() : "Owner";
  const room = document.getElementById("room").value.trim();
  const billingMonth = document.getElementById("billingMonth").value.trim();
  const { total } = computeTotals();

  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName,
    cu: "INR",
  });
  if (total > 0) {
    params.set("am", total.toFixed(2));
  }
  const note = `Rent ${room} ${billingMonth}`.trim();
  if (note) {
    params.set("tn", note);
  }

  window.location.href = `upi://pay?${params.toString()}`;
}

async function copyUpiId() {
  const upiId = document.getElementById("upi").value.trim();
  const button = document.getElementById("copyUpiBtn");
  if (!upiId) {
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(upiId);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = upiId;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    const originalText = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => {
      button.textContent = originalText;
    }, 1500);
  } catch (error) {
    console.error("Copy failed", error);
  }
}

function openOcrDebugImage(src) {
  document.getElementById("ocrDebugImage").src = src;
  document.getElementById("ocrDebugOverlay").hidden = false;
}

function closeOcrDebugImage() {
  document.getElementById("ocrDebugOverlay").hidden = true;
}

async function init() {
  await loadSavedFields();
  attachFieldPersistence();
  images.forEach(attachImageCapture);

  document.getElementById("printBtn").addEventListener("click", openPdfPreview);
  document.getElementById("pdfPreviewClose").addEventListener("click", closePdfPreview);
  document.getElementById("pdfPreviewConfirm").addEventListener("click", confirmPdfExport);
  document.getElementById("pdfPreviewPayBtn").addEventListener("click", payWithUpi);
  document.getElementById("copyUpiBtn").addEventListener("click", copyUpiId);
  document.getElementById("ocrDebugClose").addEventListener("click", closeOcrDebugImage);

  document.getElementById("imageSourceClose").addEventListener("click", closeImageSourceSheet);
  document.getElementById("imageSourceGallery").addEventListener("click", () => {
    const field = pendingImagePickerField;
    closeImageSourceSheet();
    if (field) {
      field.fileInput.click();
    }
  });
  document.getElementById("imageSourceCamera").addEventListener("click", async () => {
    const field = pendingImagePickerField;
    closeImageSourceSheet();
    if (!field) {
      return;
    }
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        quality: 80,
      });
      await storePickedImage(field, photo.dataUrl);
    } catch (error) {
      if (error && error.message === "User cancelled photos app") {
        return;
      }
      console.error("Photo capture failed", error);
    }
  });

  let lastKnownWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    // Only re-fit on a real layout change (orientation, window resize).
    // The on-screen keyboard only ever changes the height, so a
    // width-only-unchanged resize is treated as a keyboard toggle and
    // ignored, instead of shrinking the invoice preview to match it.
    if (window.innerWidth === lastKnownWidth) {
      return;
    }
    lastKnownWidth = window.innerWidth;
    lockViewportHeight();
    fitInvoiceToViewport();
    updateKeyboardState();
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateKeyboardState);
  } else {
    window.addEventListener("resize", updateKeyboardState);
  }

  refreshGeneratedAt();
  renderInvoice();
  lockViewportHeight();
  fitInvoiceToViewport();
  updateKeyboardState();
}

init();
