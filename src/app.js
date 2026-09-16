import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { createWorker } from "tesseract.js";
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
  { inputId: "qrImage", previewId: "qrPreview", ocrTargetId: null },
  { inputId: "signatureImage", previewId: "signaturePreview", ocrTargetId: null },
];

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

function renderInvoice() {
  fields.forEach((id) => setOutput(id, document.getElementById(id).value));
  setOutput("generatedAt", generatedAt);

  const currentReading = numericValue("currentReading");
  const previousReading = numericValue("previousReading");
  const rate = numericValue("rate");
  const rent = numericValue("rent");
  const deduction = numericValue("deduction");
  const otherCharges = numericValue("otherCharges");
  const units = Math.max(currentReading - previousReading, 0);
  const energyCharge = units * rate;
  const total = rent + energyCharge - deduction + otherCharges;

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

function attachFieldPersistence() {
  fields.forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      renderInvoice();
      Preferences.set({ key: fieldKey(id), value: document.getElementById(id).value });
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

async function getOcrWorker() {
  if (!ocrWorker) {
    ocrWorker = await createWorker("eng");
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

async function runOcr(dataUrl, targetId) {
  const status = document.getElementById(`${targetId}OcrStatus`);
  if (status) {
    status.textContent = "Reading meter photo…";
  }

  try {
    const worker = await getOcrWorker();
    const {
      data: { text },
    } = await worker.recognize(dataUrl);
    const reading = extractReadingFromText(text);

    if (reading !== null) {
      const input = document.getElementById(targetId);
      input.value = reading;
      renderInvoice();
      Preferences.set({ key: fieldKey(targetId), value: input.value });
      if (status) {
        status.textContent = `Detected ${reading} — please verify`;
      }
    } else if (status) {
      status.textContent = "Couldn't read digits — please enter manually";
    }
  } catch (error) {
    console.error("OCR failed", error);
    if (status) {
      status.textContent = "OCR failed — please enter manually";
    }
  }
}

function attachImageCapture({ inputId, previewId, ocrTargetId }) {
  const button = document.getElementById(`${inputId}Btn`);
  const preview = document.getElementById(previewId);

  Preferences.get({ key: imageKey(inputId) }).then(({ value }) => {
    if (value) {
      setPreviewImage(preview, inputId, value);
    }
  });

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

function fitInvoiceToViewport() {
  const wrap = document.querySelector(".preview-wrap");
  const invoice = document.getElementById("invoice");
  const naturalWidth = 1123;

  if (window.innerWidth > 900) {
    invoice.style.transform = "";
    invoice.style.marginBottom = "";
    return;
  }

  const scale = Math.min(1, (wrap.clientWidth - 24) / naturalWidth);
  invoice.style.transformOrigin = "top left";
  invoice.style.transform = `scale(${scale})`;
  invoice.style.marginBottom = `${invoice.offsetHeight * (scale - 1)}px`;
}

async function exportPdf() {
  const printBtn = document.getElementById("printBtn");
  const invoice = document.getElementById("invoice");
  const previousTransform = invoice.style.transform;
  const previousMargin = invoice.style.marginBottom;

  printBtn.disabled = true;
  printBtn.textContent = "Generating…";
  invoice.style.transform = "";
  invoice.style.marginBottom = "";

  try {
    refreshGeneratedAt();
    renderInvoice();

    const canvas = await html2canvas(invoice, { scale: 2, useCORS: true });
    const imgData = canvas.toDataURL("image/jpeg", 0.92);

    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pageWidth / canvas.width, pageHeight / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;
    const x = (pageWidth - width) / 2;
    const y = (pageHeight - height) / 2;

    pdf.addImage(imgData, "JPEG", x, y, width, height);

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
  } catch (error) {
    console.error("PDF export failed", error);
  } finally {
    invoice.style.transform = previousTransform;
    invoice.style.marginBottom = previousMargin;
    printBtn.disabled = false;
    printBtn.textContent = "Download A4 PDF";
  }
}

async function init() {
  await loadSavedFields();
  attachFieldPersistence();
  images.forEach(attachImageCapture);

  document.getElementById("printBtn").addEventListener("click", exportPdf);
  window.addEventListener("resize", fitInvoiceToViewport);

  refreshGeneratedAt();
  renderInvoice();
  fitInvoiceToViewport();
}

init();
