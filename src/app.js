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
  "deductionReason",
  "otherCharges",
  "otherChargesReason",
  "currentDate",
  "previousDate",
];

const images = [
  { inputId: "currentImage", previewId: "currentImagePreview", ocrTargetId: "currentReading" },
  { inputId: "previousImage", previewId: "previousImagePreview", ocrTargetId: "previousReading" },
  { inputId: "qrImage", previewId: "qrPreview", ocrTargetId: null, requiresPin: true },
  { inputId: "signatureImage", previewId: "signaturePreview", ocrTargetId: null, requiresPin: true },
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
  deductionReason: ["row-total"],
  otherCharges: ["row-total", "row-other"],
  otherChargesReason: ["row-other"],
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

// Address, UPI ID, the payment QR, and the owner's signature belong to the
// landlord and almost never change between invoices — Refresh leaves them
// alone and only clears the per-invoice fields/photos (room, tenant,
// readings, dates, meter photos). Those two stay editable only through
// their own "Add photo" buttons.
const REFRESH_STICKY_FIELDS = new Set(["address", "upi"]);
const REFRESH_STICKY_IMAGES = new Set(["qrImage", "signatureImage"]);

const IMAGE_PLACEHOLDER_TEXT = {
  currentImagePreview: "Add current meter image",
  previousImagePreview: "Add previous meter image",
};

async function resetForNewInvoice() {
  const confirmed = window.confirm(
    "Clear all fields and meter photos for a new invoice? Address, UPI ID, QR code, and signature will be kept.",
  );
  if (!confirmed) {
    return;
  }

  await Promise.all(
    fields
      .filter((id) => !REFRESH_STICKY_FIELDS.has(id))
      .map(async (id) => {
        document.getElementById(id).value = "";
        await Preferences.remove({ key: fieldKey(id) });
      }),
  );

  document.getElementById("currentReadingOcrStatus").textContent = "";
  document.getElementById("previousReadingOcrStatus").textContent = "";

  await Promise.all(
    images
      .filter(({ inputId }) => !REFRESH_STICKY_IMAGES.has(inputId))
      .map(async ({ inputId, previewId }) => {
        document.getElementById(previewId).textContent = IMAGE_PLACEHOLDER_TEXT[previewId] || "";
        await Preferences.remove({ key: imageKey(inputId) });
      }),
  );

  renderInvoice();
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
  const deductionReason = document.getElementById("deductionReason").value.trim();
  setOutput("deductionFormula", deduction ? `-${money.format(deduction)}${deductionReason ? ` (${deductionReason})` : ""}` : "");
  setOutput("otherFormula", otherCharges ? ` + ${money.format(otherCharges)}(other charges)` : "");

  const otherChargesReason = document.getElementById("otherChargesReason").value.trim();
  setOutput("otherChargesReasonFormatted", otherChargesReason ? ` (${otherChargesReason})` : "");
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

// Otsu's method: finds the luminance threshold that best separates a
// bimodal histogram into two clusters by maximizing the variance between
// them, with no assumption about which cluster is "foreground".
function computeOtsuThreshold(histogram, totalPixels) {
  let sumAll = 0;
  for (let t = 0; t < 256; t++) {
    sumAll += t * histogram[t];
  }

  let sumBelow = 0;
  let countBelow = 0;
  let bestThreshold = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    countBelow += histogram[t];
    if (countBelow === 0) {
      continue;
    }
    const countAbove = totalPixels - countBelow;
    if (countAbove === 0) {
      break;
    }

    sumBelow += t * histogram[t];
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sumAll - sumBelow) / countAbove;
    const betweenVariance = countBelow * countAbove * (meanBelow - meanAbove) * (meanBelow - meanAbove);

    if (betweenVariance > bestVariance) {
      bestVariance = betweenVariance;
      bestThreshold = t;
    }
  }

  return bestThreshold;
}

function binarizeDisplayCanvas(canvas) {
  // Reusing the green-detector test here (as this used to) only makes
  // sense for a real green-backlit LCD — for anything else (a plain
  // black-on-white reference image, a different backlight color, or even
  // JPEG compression noise on an otherwise-clean photo) that test has no
  // relationship to "is this a digit or the background", and produces
  // near-random per-pixel noise instead of real thresholding. Otsu's
  // method finds the actual brightness split in *this* image's own
  // histogram, so it works regardless of the display's real colors.
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  const pixelCount = data.length / 4;

  const histogram = new Array(256).fill(0);
  const luminances = new Uint8ClampedArray(pixelCount);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const luminance = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    luminances[p] = luminance;
    histogram[luminance] += 1;
  }

  const threshold = computeOtsuThreshold(histogram, pixelCount);

  let darkCount = 0;
  for (let t = 0; t <= threshold; t++) {
    darkCount += histogram[t];
  }
  // The digit strokes are always a small minority of a display's area, so
  // whichever side of the threshold covers fewer pixels is the ink/segment
  // color — regardless of whether that's the dark or the light side.
  const darkIsForeground = darkCount < pixelCount - darkCount;

  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    const isDark = luminances[p] <= threshold;
    const isForeground = darkIsForeground ? isDark : !isDark;
    const value = isForeground ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }

  ctx.putImageData(imageData, 0, 0);
}

// Direct seven-segment decoding: classic OCR engines (both Tesseract's
// default LSTM model and the community "letsgodigital" model trained
// specifically for digital displays) were tested against real device
// photos and real-world clean seven-segment renders and misread them
// badly even on a perfectly binarized image — they're trained on natural
// typefaces, not disconnected-segment glyphs. Since our own crop+binarize
// step already produces a clean black-ink-on-white image, decoding the
// seven segments directly (which segment shape has a digit lit) is both
// more accurate and instant, with no model to load.
const SEGMENT_PATTERNS = {
  "1111110": "0",
  "0110000": "1",
  "1101101": "2",
  "1111001": "3",
  "0110011": "4",
  "1011011": "5",
  "1011111": "6",
  "1110000": "7",
  "1111111": "8",
  "1111011": "9",
};
// Bit order for each pattern above: a (top), b (top-right), c (bottom-right),
// d (bottom), e (bottom-left), f (top-left), g (middle).

function segmentFraction(data, width, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.round(x0));
  y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(width, Math.round(x1));
  y1 = Math.round(y1);
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      total++;
      if (data[i] < 128) dark++;
    }
  }
  return total === 0 ? 0 : dark / total;
}

function classifySevenSegmentDigit(imageData, box) {
  const { data, width } = imageData;
  const { x0, y0, x1, y1 } = box;
  const w = x1 - x0;
  const h = y1 - y0;

  // A narrow blob relative to its height is almost always "1" — its ink
  // occupies only the right-side vertical segments, positioned wherever
  // the digit was drawn rather than centered in a full digit-cell width.
  if (w / h < 0.35) {
    return "1";
  }

  const bandT = 0.16; // thickness of horizontal segment sample bands, as a fraction of h
  const sideW = 0.32; // width of vertical segment sample bands, as a fraction of w
  const threshold = 0.32;

  const a = segmentFraction(data, width, x0 + w * 0.25, y0, x0 + w * 0.75, y0 + h * bandT);
  const g = segmentFraction(
    data,
    width,
    x0 + w * 0.25,
    y0 + h * (0.5 - bandT / 2),
    x0 + w * 0.75,
    y0 + h * (0.5 + bandT / 2),
  );
  const d = segmentFraction(data, width, x0 + w * 0.25, y0 + h * (1 - bandT), x0 + w * 0.75, y1);
  const f = segmentFraction(data, width, x0, y0 + h * 0.08, x0 + w * sideW, y0 + h * 0.47);
  const b = segmentFraction(data, width, x0 + w * (1 - sideW), y0 + h * 0.08, x1, y0 + h * 0.47);
  const e = segmentFraction(data, width, x0, y0 + h * 0.53, x0 + w * sideW, y0 + h * 0.92);
  const c = segmentFraction(data, width, x0 + w * (1 - sideW), y0 + h * 0.53, x1, y0 + h * 0.92);

  const bits = [a, b, c, d, e, f, g].map((value) => (value >= threshold ? "1" : "0")).join("");
  return SEGMENT_PATTERNS[bits] ?? null;
}

const INK_COMPONENT_MIN_PIXELS = 12;

// A real meter display's LCD area usually holds more than just the main
// reading — a decimal-fraction sub-display, a "kWh" unit label, a small
// icon — all in the same green-detected region. A column-based split (any
// fully ink-free column starts a new digit) has no way to tell those
// apart from the real digits, and confidently produced a wrong reading
// from whichever few of them happened to land in range. Connected-component
// labeling gives each visually separate glyph its own tight bounding box
// regardless of where it sits, so the ones that are much shorter than the
// main reading's digits (the decimal sub-display, unit text) can be
// filtered out by height below, instead of silently corrupting the result.
function findInkComponents(imageData, scanBox, isInk) {
  const { width, height } = imageData;
  const x0 = Math.max(0, Math.round(scanBox.x0));
  const y0 = Math.max(0, Math.round(scanBox.y0));
  const x1 = Math.min(width, Math.round(scanBox.x1));
  const y1 = Math.min(height, Math.round(scanBox.y1));
  const boxW = x1 - x0;
  const boxH = y1 - y0;
  if (boxW <= 0 || boxH <= 0) {
    return [];
  }

  const visited = new Uint8Array(boxW * boxH);
  const stackX = new Int32Array(boxW * boxH);
  const stackY = new Int32Array(boxW * boxH);

  const components = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const localIndex = (y - y0) * boxW + (x - x0);
      if (visited[localIndex] || !isInk(x, y)) {
        continue;
      }

      let top = y;
      let bottom = y;
      let left = x;
      let right = x;
      let count = 0;
      let stackSize = 0;
      stackX[stackSize] = x;
      stackY[stackSize] = y;
      stackSize++;
      visited[localIndex] = 1;

      while (stackSize > 0) {
        stackSize--;
        const cx = stackX[stackSize];
        const cy = stackY[stackSize];
        count++;
        if (cx < left) left = cx;
        if (cx > right) right = cx;
        if (cy < top) top = cy;
        if (cy > bottom) bottom = cy;

        const neighbors = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const neighborIndex = (ny - y0) * boxW + (nx - x0);
          if (visited[neighborIndex] || !isInk(nx, ny)) continue;
          visited[neighborIndex] = 1;
          stackX[stackSize] = nx;
          stackY[stackSize] = ny;
          stackSize++;
        }
      }

      if (count >= INK_COMPONENT_MIN_PIXELS) {
        components.push({ x0: left, y0: top, x1: right + 1, y1: bottom + 1, count });
      }
    }
  }
  return components;
}

// Some seven-segment fonts render each segment with a small mitered gap at
// the corners where it visually meets its neighbors, so a single digit can
// come back as several disconnected ink components (e.g. a top bar
// separate from the verticals below it). Union-Find components whose
// bounding boxes are within a small margin of overlapping — bounding-box
// proximity rather than requiring actually-touching pixels, since that's
// exactly what a mitered corner defeats. The margin is a fraction of the
// display's height so it scales with photo resolution/zoom, tuned to sit
// above real segment-corner gaps and below the gap between two digits.
function mergeInkFragments(components, mergeRadius) {
  const n = components.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = components[i];
      const b = components[j];
      const hGap = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
      const vGap = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
      if (hGap <= mergeRadius && vGap <= mergeRadius) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(components[i]);
  }

  return Array.from(groups.values()).map((members) => ({
    x0: Math.min(...members.map((m) => m.x0)),
    y0: Math.min(...members.map((m) => m.y0)),
    x1: Math.max(...members.map((m) => m.x1)),
    y1: Math.max(...members.map((m) => m.y1)),
  }));
}

// The main reading's digits are the tallest glyphs in the display (taller
// than a decimal sub-reading or unit text), and share roughly the same
// vertical position — used to isolate just them from whatever else shares
// the display.
function selectMainDigitComponents(components) {
  if (components.length === 0) {
    return [];
  }
  const maxHeight = Math.max(...components.map((c) => c.y1 - c.y0));
  const tall = components.filter((c) => c.y1 - c.y0 >= maxHeight * 0.65);
  const centers = tall.map((c) => (c.y0 + c.y1) / 2).sort((a, b) => a - b);
  const medianCenter = centers[Math.floor(centers.length / 2)];
  const aligned = tall.filter((c) => Math.abs((c.y0 + c.y1) / 2 - medianCenter) <= maxHeight * 0.35);
  aligned.sort((a, b) => a.x0 - b.x0);
  return aligned;
}

// contentBox is meant to already exclude the display's own dark bezel, but
// that boundary was measured on the original, unbinarized photo, where a
// real bezel's inner edge blurs into the glass over several pixels rather
// than stopping cleanly — so a hair's-width sliver of it can still land
// just inside. Undetected, that sliver forms a loop touching every digit
// at once, merging them all into one shape. Peel off only a genuine
// full-span line hugging an edge (checked directly, not assumed) rather
// than a blanket inward margin, which would just as easily slice into a
// real digit that happens to sit close to that same edge.
function peelBorderFrame(box, isInk) {
  let { x0, y0, x1, y1 } = box;
  const maxPeelX = (x1 - x0) * 0.15;
  const maxPeelY = (y1 - y0) * 0.15;

  const rowDarkFraction = (y) => {
    let dark = 0;
    let total = 0;
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      total++;
      if (isInk(x, y)) dark++;
    }
    return total === 0 ? 0 : dark / total;
  };
  const colDarkFraction = (x) => {
    let dark = 0;
    let total = 0;
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      total++;
      if (isInk(x, y)) dark++;
    }
    return total === 0 ? 0 : dark / total;
  };

  let peeled = 0;
  while (peeled < maxPeelY && y0 < y1 - 1 && rowDarkFraction(Math.round(y0)) > 0.5) {
    y0++;
    peeled++;
  }
  peeled = 0;
  while (peeled < maxPeelY && y1 > y0 + 1 && rowDarkFraction(Math.round(y1) - 1) > 0.5) {
    y1--;
    peeled++;
  }
  peeled = 0;
  while (peeled < maxPeelX && x0 < x1 - 1 && colDarkFraction(Math.round(x0)) > 0.5) {
    x0++;
    peeled++;
  }
  peeled = 0;
  while (peeled < maxPeelX && x1 > x0 + 1 && colDarkFraction(Math.round(x1) - 1) > 0.5) {
    x1--;
    peeled++;
  }

  return { x0, y0, x1, y1 };
}

// A frame that runs at a slight angle (a photo rarely captures the meter
// perfectly square-on) can leak past peelBorderFrame entirely — no single
// row or column crosses its 50% threshold, but the tilted line still
// connects across the box as a 2D path, pixel-adjacency by pixel-adjacency,
// bridging every digit into one shape at the raw component stage, before
// any of the merge logic below even runs. Real digit strokes are always
// much thicker than a photographed frame line, though, so shrinking every
// ink region inward by a couple of pixels (erosion) severs a thin bridge
// like that while leaving the digit strokes still solidly connected to
// themselves. An integral image makes each pixel's box-sum check O(1)
// instead of O(radius²), so this stays cheap over a multi-megapixel crop.
function buildIntegralImage(imageData, box, isInk) {
  const x0 = Math.round(box.x0);
  const y0 = Math.round(box.y0);
  const x1 = Math.round(box.x1);
  const y1 = Math.round(box.y1);
  const w = x1 - x0;
  const h = y1 - y0;
  const integral = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOut = (y + 1) * (w + 1);
    const rowPrevOut = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowSum += isInk(x0 + x, y0 + y) ? 1 : 0;
      integral[rowOut + x + 1] = integral[rowPrevOut + x + 1] + rowSum;
    }
  }
  return { integral, w, h, x0, y0 };
}

function makeErodedInk(imageData, box, isInk, radius) {
  const img = buildIntegralImage(imageData, box, isInk);
  return (x, y) => {
    const lx = Math.max(0, x - img.x0 - radius);
    const ly = Math.max(0, y - img.y0 - radius);
    const hx = Math.min(img.w, x - img.x0 + radius + 1);
    const hy = Math.min(img.h, y - img.y0 + radius + 1);
    if (hx <= lx || hy <= ly) return false;
    const sum =
      img.integral[hy * (img.w + 1) + hx] -
      img.integral[ly * (img.w + 1) + hx] -
      img.integral[hy * (img.w + 1) + lx] +
      img.integral[ly * (img.w + 1) + lx];
    return sum === (hx - lx) * (hy - ly);
  };
}

const EROSION_RADIUS = 2;

function recognizeSevenSegmentReading(canvas, contentBox) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rawBox = contentBox ?? { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };

  const isBinarizedInk = (x, y) => imageData.data[(y * imageData.width + x) * 4] < 128;
  const scanBox = peelBorderFrame(rawBox, isBinarizedInk);
  const erodedInk = makeErodedInk(imageData, scanBox, isBinarizedInk, EROSION_RADIUS);
  const erodedComponents = findInkComponents(imageData, scanBox, erodedInk);
  // A sparse, spread-out shape — e.g. a corner bracket or an L formed by a
  // side bar meeting a top trim strip, still present after erosion because
  // each stroke on its own is thick enough to survive — has a bounding box
  // far bigger than the ink actually inside it. mergeInkFragments below
  // works off bounding-box distance, so a box that size would read as
  // "close to" every digit in the display and merge them all into one.
  // Real digit strokes (or fragments of one) always fill a solid fraction
  // of their own bounding box; this is cheap insurance against a shape
  // that clearly isn't one.
  const MIN_FILL_RATIO = 0.12;
  const compact = erodedComponents.filter((c) => {
    const area = (c.x1 - c.x0) * (c.y1 - c.y0);
    return area > 0 && c.count / area >= MIN_FILL_RATIO;
  });
  // Erosion shrinks every shape inward by the radius, so grow each
  // surviving component back out by the same amount to recover the
  // digit's real extent before sampling its segments.
  const rawComponents = compact.map((c) => ({
    x0: Math.max(scanBox.x0, c.x0 - EROSION_RADIUS),
    y0: Math.max(scanBox.y0, c.y0 - EROSION_RADIUS),
    x1: Math.min(scanBox.x1, c.x1 + EROSION_RADIUS),
    y1: Math.min(scanBox.y1, c.y1 + EROSION_RADIUS),
  }));
  const mergeRadius = Math.max(2, (scanBox.y1 - scanBox.y0) * 0.05);
  const merged = mergeInkFragments(rawComponents, mergeRadius);
  const boxes = selectMainDigitComponents(merged);

  if (boxes.length < 2 || boxes.length > 6) {
    return null;
  }

  let reading = "";
  for (const box of boxes) {
    const digit = classifySevenSegmentDigit(imageData, box);
    if (digit === null) {
      return null;
    }
    reading += digit;
  }
  return reading;
}

// How tightly the display's own background color clusters, sampled from
// the non-ink pixels inside a bezel candidate. A real LCD's background is
// close to one flat color (whatever its backlight — green, blue, or an
// unlit monochrome gray/white); a false match like a printed logo banner
// mixes several distinct colors, so its pixels scatter far more widely in
// RGB space. Empirically real bezels landed under ~30, false matches over
// ~50 on real device photos — the cutoff below sits with margin on both
// sides.
function colorUniformity(data, width, box, isDark) {
  const { x0, y0, x1, y1 } = box;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;
  const samples = [];
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      if (isDark(x, y)) continue;
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      samples.push([r, g, b]);
      sumR += r;
      sumG += g;
      sumB += b;
      n++;
    }
  }
  if (n < 10) {
    return 999;
  }
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;
  let variance = 0;
  for (const [r, g, b] of samples) {
    variance += (r - meanR) ** 2 + (g - meanG) ** 2 + (b - meanB) ** 2;
  }
  return Math.sqrt(variance / n);
}

// Tuned against two real device photos: a genuine display's std dev came
// in around 9-42 (glare and shadow gradients on the glass push it up), a
// false match (a busy printed logo/text banner that happened to form a
// hollow-looking connected blob) came in around 50 — this sits with
// margin between the two.
const BEZEL_MAX_COLOR_STD_DEV = 46;

// Locating the display by its dark rectangular bezel, instead of by the
// backlight's color, is what makes this work for a monochrome display and
// for a green/blue one alike — and it also avoids a real failure mode the
// color tiers below have: a real meter's plastic body can itself carry
// enough of a color cast under ordinary indoor lighting to satisfy a
// "green enough" test across nearly the whole photo, not just the display.
// Almost every digital meter has a distinctly dark frame around the LCD
// glass, so it's found here as a dark, hollow (frame-shaped), moderately
// large, roughly-rectangular connected component with a uniformly colored
// interior.
function findDisplayBezelBox(imageData) {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  const luminance = new Uint8ClampedArray(totalPixels);
  const histogram = new Array(256).fill(0);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    luminance[p] = l;
    histogram[l] += 1;
  }
  const threshold = computeOtsuThreshold(histogram, totalPixels);
  const isDark = (x, y) => luminance[y * width + x] <= threshold;
  // A real photo's frame-to-glass edge is a gradient over several pixels
  // (blur, JPEG compression), not a clean binary step, so pixels right at
  // that edge sit ambiguously close to the threshold. Used only when
  // measuring the glass's own extent below — requiring real margin above
  // the threshold keeps those transition pixels from being counted as
  // "light" and letting a sliver of the frame leak into the display box.
  const isConfidentlyLight = (x, y) => luminance[y * width + x] > threshold + 20;

  const components = findInkComponents(imageData, { x0: 0, y0: 0, x1: width, y1: height }, isDark);

  const imageArea = width * height;
  let best = null;
  for (const c of components) {
    const w = c.x1 - c.x0;
    const h = c.y1 - c.y0;
    const areaFraction = (w * h) / imageArea;
    const aspect = w / h;
    if (areaFraction < 0.01 || areaFraction > 0.45) continue;
    if (aspect < 1.2 || aspect > 7) continue;

    // Hollow check: the inner ~50% of the bbox should be mostly NOT part
    // of this dark component — confirms a frame around a lighter
    // interior, not a solid dark block like printed text/logo.
    const ix0 = c.x0 + w * 0.25;
    const ix1 = c.x0 + w * 0.75;
    const iy0 = c.y0 + h * 0.25;
    const iy1 = c.y0 + h * 0.75;
    let innerDark = 0;
    let innerTotal = 0;
    for (let y = Math.round(iy0); y < Math.round(iy1); y += 2) {
      for (let x = Math.round(ix0); x < Math.round(ix1); x += 2) {
        innerTotal++;
        if (isDark(x, y)) innerDark++;
      }
    }
    if (innerTotal === 0 || innerDark / innerTotal > 0.35) continue;

    const colorStdDev = colorUniformity(data, width, { x0: ix0, y0: iy0, x1: ix1, y1: iy1 }, isDark);
    if (colorStdDev > BEZEL_MAX_COLOR_STD_DEV) continue;

    if (!best || colorStdDev < best.colorStdDev) {
      // The component's own bbox is the frame's OUTER edge, which still
      // includes the frame itself — not what downstream cropping expects
      // (the green/hue tiers hand back the bbox of the display's own
      // light pixels, which naturally excludes their dark bezel too).
      // Re-scan for the tight bounding box of the light pixels strictly
      // inside the frame, so both paths hand back the same kind of box —
      // the display's glass, not its frame.
      let lightMinX = c.x1;
      let lightMinY = c.y1;
      let lightMaxX = c.x0;
      let lightMaxY = c.y0;
      for (let y = c.y0; y < c.y1; y++) {
        for (let x = c.x0; x < c.x1; x++) {
          if (!isConfidentlyLight(x, y)) continue;
          if (x < lightMinX) lightMinX = x;
          if (x > lightMaxX) lightMaxX = x;
          if (y < lightMinY) lightMinY = y;
          if (y > lightMaxY) lightMaxY = y;
        }
      }
      if (lightMinX >= lightMaxX || lightMinY >= lightMaxY) continue;
      // A small extra inward margin, on top of the confidence margin
      // above, as a second line of defense against any remaining sliver
      // of the frame — cheap insurance since the padding added during
      // cropping (below) already compensates for a slightly tight box.
      const erodeX = Math.max(2, (lightMaxX - lightMinX) * 0.03);
      const erodeY = Math.max(2, (lightMaxY - lightMinY) * 0.03);
      const finalMinX = lightMinX + erodeX;
      const finalMinY = lightMinY + erodeY;
      const finalMaxX = lightMaxX + 1 - erodeX;
      const finalMaxY = lightMaxY + 1 - erodeY;
      if (finalMinX >= finalMaxX || finalMinY >= finalMaxY) continue;
      best = {
        minX: finalMinX,
        minY: finalMinY,
        maxX: finalMaxX,
        maxY: finalMaxY,
        regionWidth: finalMaxX - finalMinX,
        regionHeight: finalMaxY - finalMinY,
        colorStdDev,
      };
    }
  }
  return best;
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
  const imageArea = width * height;
  let region = null;
  let usedTierName = null;

  // Try locating the display by its bezel first (works for any backlight
  // color, or none) — only fall back to the color/hue tiers, which need a
  // saturated colored backlight and can be fooled by a meter body with its
  // own slight color cast, when no confident bezel is found.
  region = findDisplayBezelBox(imageData);
  if (region) {
    usedTierName = "bezel";
  } else {
    for (const tier of GREEN_DETECTOR_TIERS) {
      const candidate = findGreenBoundingBox(imageData, tier.test);
      // A real display is always a small part of a full meter photo — a
      // match covering most of the frame means the tier's color test
      // matched the meter body itself, not just the display.
      if (candidate && (candidate.regionWidth * candidate.regionHeight) / imageArea <= 0.45) {
        region = candidate;
        usedTierName = tier.name;
        break;
      }
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
  binarizeDisplayCanvas(cropCanvas);

  // The padding added above (to avoid clipping digit strokes right at the
  // detected edge) reaches outside the real display into whatever
  // surrounds it in the photo — a meter's dark bezel, a table surface,
  // etc. Binarizing the whole crop can turn that surrounding area into a
  // solid dark border touching the image edges. That's harmless for a
  // human glancing at the debug preview or for Tesseract, but it would
  // make the segment decoder's edge-to-edge ink scan treat the border
  // itself as a huge "digit". Pass along the padding-free content
  // rectangle (in this canvas's own pixel coordinates) so the decoder can
  // scan only inside the real display area.
  const contentBox = {
    x0: (minX - cropX) * GREEN_CROP_UPSCALE,
    y0: (minY - cropY) * GREEN_CROP_UPSCALE,
    x1: (minX - cropX + regionWidth) * GREEN_CROP_UPSCALE,
    y1: (minY - cropY + regionHeight) * GREEN_CROP_UPSCALE,
  };

  return {
    dataUrl: cropCanvas.toDataURL("image/png"),
    cropped: true,
    tier: usedTierName,
    canvas: cropCanvas,
    contentBox,
  };
}

async function runOcr(dataUrl, targetId) {
  const status = document.getElementById(`${targetId}OcrStatus`);
  if (status) {
    status.textContent = "Reading meter photo…";
  }

  try {
    const { dataUrl: displayDataUrl, cropped, tier, canvas: cropCanvas, contentBox } = await cropToDisplayRegion(dataUrl);

    // Try the deterministic seven-segment decoder first: it's instant (no
    // model to load) and, unlike Tesseract, was built for exactly this
    // glyph shape. Only fall back to Tesseract if it can't produce a
    // confident full reading (e.g. a non-seven-segment display, or a crop
    // that clipped a digit).
    const segmentReading = cropCanvas ? recognizeSevenSegmentReading(cropCanvas, contentBox) : null;

    let reading = segmentReading;
    let text = "";
    if (reading === null) {
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
      const recognized = await withTimeout(worker.recognize(displayDataUrl), OCR_TIMEOUT_MS, "Timed out reading the photo");
      text = recognized.data.text;
      reading = extractReadingFromText(text);
    }

    if (reading !== null) {
      // A meter always shows the reading padded to a fixed digit count
      // ("000162"), but the field should hold the actual number.
      reading = reading.replace(/^0+(?=\d)/, "");
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

const PIN_KEY = "rent-billing-security-pin";
let pinResolve = null;
let pinMode = "enter";

function showPinOverlay(mode, message) {
  pinMode = mode;
  const title = document.getElementById("pinTitle");
  const msg = document.getElementById("pinMessage");
  const input = document.getElementById("pinInput");
  const confirmInput = document.getElementById("pinConfirmInput");
  const error = document.getElementById("pinError");
  const forgotBtn = document.getElementById("pinForgot");

  error.hidden = true;
  input.value = "";
  confirmInput.value = "";

  if (mode === "set") {
    title.textContent = "Set a PIN";
    msg.textContent = message || "Set a PIN to protect the QR code and signature from being changed by accident.";
    confirmInput.hidden = false;
    forgotBtn.hidden = true;
  } else {
    title.textContent = "Enter PIN";
    msg.textContent = message || "Enter your PIN to continue.";
    confirmInput.hidden = true;
    forgotBtn.hidden = false;
  }

  document.getElementById("pinOverlay").hidden = false;
  input.focus();
}

function closePinOverlay() {
  document.getElementById("pinOverlay").hidden = true;
}

function resolvePin(granted) {
  closePinOverlay();
  const resolve = pinResolve;
  pinResolve = null;
  if (resolve) {
    resolve(granted);
  }
}

// Gates the QR/signature "Add photo" buttons behind a PIN so they can't be
// changed by an accidental tap, without needing any server: the PIN itself
// (and its "forgot PIN" reset) lives entirely in this device's own
// Preferences, same as everything else the app stores.
function verifyPin() {
  return new Promise((resolve) => {
    pinResolve = resolve;
    Preferences.get({ key: PIN_KEY }).then(({ value: storedPin }) => {
      showPinOverlay(storedPin ? "enter" : "set");
    });
  });
}

async function submitPin() {
  const input = document.getElementById("pinInput");
  const confirmInput = document.getElementById("pinConfirmInput");
  const error = document.getElementById("pinError");
  const pin = input.value.trim();

  if (pinMode === "set") {
    if (pin.length < 4) {
      error.textContent = "PIN must be at least 4 digits.";
      error.hidden = false;
      return;
    }
    if (pin !== confirmInput.value.trim()) {
      error.textContent = "PINs don't match.";
      error.hidden = false;
      return;
    }
    await Preferences.set({ key: PIN_KEY, value: pin });
    resolvePin(true);
    return;
  }

  const { value: storedPin } = await Preferences.get({ key: PIN_KEY });
  if (pin !== storedPin) {
    error.textContent = "Incorrect PIN.";
    error.hidden = false;
    input.value = "";
    input.focus();
    return;
  }
  resolvePin(true);
}

async function forgotPin() {
  const confirmed = window.confirm("Reset your PIN? You'll set a new one now.");
  if (!confirmed) {
    return;
  }
  await Preferences.remove({ key: PIN_KEY });
  showPinOverlay("set", "Set a new PIN to protect the QR code and signature.");
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

  if (field.ocrTargetId) {
    runOcr(flattened, field.ocrTargetId);
  }
}

function attachImageCapture({ inputId, previewId, ocrTargetId, requiresPin }) {
  const button = document.getElementById(`${inputId}Btn`);
  const preview = document.getElementById(previewId);

  Preferences.get({ key: imageKey(inputId) }).then(({ value }) => {
    if (!value) {
      return;
    }
    // An image saved before this field switched from Camera.getPhoto to a
    // file picker was captured through the old, lossy JPEG re-encode
    // path — any transparency in it was already flattened to black
    // before it was ever stored, so there's nothing left to fix by
    // loading it. Discard it instead of redisplaying a black box on
    // every app open; the placeholder prompts a fresh pick.
    if (value.startsWith("data:image/jpeg")) {
      Preferences.remove({ key: imageKey(inputId) });
      return;
    }
    setPreviewImage(preview, inputId, value);
  });

  // Images are often pre-made graphics with transparency (e.g. a
  // signature exported as a PNG with a transparent background).
  // Capacitor's Camera plugin always re-encodes its result as JPEG
  // (Bitmap.CompressFormat.JPEG, hardcoded natively, no PNG option) —
  // JPEG has no alpha channel, so any transparent pixels get flattened to
  // whatever RGB value sits beneath them, which is black for most PNGs.
  // Picking through a plain file input reads the original file bytes
  // untouched, so transparency survives.
  //
  // The OS's default file-input chooser doesn't reliably offer a
  // "Camera" option on every device (confirmed missing on a real one),
  // so every image field (meter photos included) gets the same small
  // "Take photo / Choose from gallery" sheet (#imageSourceOverlay)
  // instead of relying on either single picker alone: gallery goes
  // through this file input (transparency-safe), camera goes through
  // Camera.getPhoto with source: Camera specifically (a live photo never
  // has transparency to lose in the first place).
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  const field = { inputId, preview, fileInput, ocrTargetId };

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

  button.addEventListener("click", async () => {
    if (requiresPin && !(await verifyPin())) {
      return;
    }
    openImageSourceSheet(field);
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

function sizePreviewForKeyboard(currentHeight) {
  // Instead of an arbitrary fixed shrink height, work out how much space
  // two stacked field rows actually need on this device/font size and
  // give the preview whatever's left, so the form always keeps room to
  // show the field being edited plus the next one for context.
  const header = document.querySelector(".app-header");
  const controls = document.querySelector(".controls");
  const controlFields = document.querySelector(".control-fields");
  const footer = document.querySelector(".control-footer");
  // A single field label (not a whole .control-grid group, which at this
  // width stacks to one column and can hold up to six fields — measuring
  // that would wildly overestimate what "one field" needs).
  const sampleField = controlFields ? controlFields.querySelector("label") : null;
  const sampleGrid = controlFields ? controlFields.querySelector(".control-grid") : null;
  if (!header || !controls || !controlFields || !footer || !sampleField || !sampleGrid) {
    return;
  }

  const controlsStyle = getComputedStyle(controls);
  const gridStyle = getComputedStyle(sampleGrid);
  const footerStyle = getComputedStyle(footer);

  const headerHeight = header.getBoundingClientRect().height;
  const controlsPadding = parseFloat(controlsStyle.paddingTop) + parseFloat(controlsStyle.paddingBottom);
  const footerOuterHeight = footer.getBoundingClientRect().height + parseFloat(footerStyle.marginTop);
  const fieldGap = parseFloat(gridStyle.rowGap) || parseFloat(gridStyle.gap) || 14;
  const fieldHeight = sampleField.getBoundingClientRect().height;
  const twoRowsHeight = fieldHeight * 2 + fieldGap;

  const chromeHeight = headerHeight + controlsPadding + footerOuterHeight;
  const naturalMax = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-vh")) * 0.46 || 300;
  const previewHeight = Math.max(60, Math.min(naturalMax, currentHeight - chromeHeight - twoRowsHeight));

  document.documentElement.style.setProperty("--keyboard-preview-height", `${previewHeight}px`);
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
  // preview (via sizePreviewForKeyboard, plus a rescale) hands the space
  // two field rows need back to the form while keeping the invoice
  // visible rather than hiding it outright.
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
  if (keyboardOpen) {
    sizePreviewForKeyboard(currentHeight);
  }
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
  document.getElementById("refreshBtn").addEventListener("click", resetForNewInvoice);
  document.getElementById("pdfPreviewClose").addEventListener("click", closePdfPreview);
  document.getElementById("pdfPreviewConfirm").addEventListener("click", confirmPdfExport);
  document.getElementById("pdfPreviewPayBtn").addEventListener("click", payWithUpi);
  document.getElementById("copyUpiBtn").addEventListener("click", copyUpiId);
  document.getElementById("ocrDebugClose").addEventListener("click", closeOcrDebugImage);

  document.getElementById("pinClose").addEventListener("click", () => resolvePin(false));
  document.getElementById("pinSubmit").addEventListener("click", submitPin);
  document.getElementById("pinForgot").addEventListener("click", forgotPin);
  ["pinInput", "pinConfirmInput"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        submitPin();
      }
    });
  });

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
