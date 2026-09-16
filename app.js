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

const money = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

let generatedAt = "";

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

  const otherChargesReason = document.getElementById("otherChargesReason").value.trim();
  setOutput("otherChargesReasonNote", otherChargesReason ? ` (${otherChargesReason})` : "");
}

function attachImageInput(inputId, previewId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const storageKey = `rent-billing-${inputId}`;

  function setPreviewImage(source) {
    preview.innerHTML = "";
    const image = document.createElement("img");
    image.alt = inputId.replace("Image", " meter image");
    image.src = source;
    preview.appendChild(image);
  }

  const savedImage = localStorage.getItem(storageKey);
  if (savedImage) {
    setPreviewImage(savedImage);
  }

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      localStorage.setItem(storageKey, reader.result);
      setPreviewImage(reader.result);
    });
    reader.readAsDataURL(file);
  });
}

fields.forEach((id) => {
  document.getElementById(id).addEventListener("input", renderInvoice);
});

document.getElementById("otherChargesReason").addEventListener("input", renderInvoice);

attachImageInput("currentImage", "currentImagePreview");
attachImageInput("previousImage", "previousImagePreview");
attachImageInput("qrImage", "qrPreview");
attachImageInput("signatureImage", "signaturePreview");

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("PDF generation timed out")), ms)),
  ]);
}

function getPrintOnlyCss() {
  let css = "";
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      continue;
    }
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.media.mediaText.includes("print")) {
        for (const innerRule of rule.cssRules) {
          css += `${innerRule.cssText}\n`;
        }
      }
    }
  }
  return css;
}

document.getElementById("printBtn").addEventListener("click", async () => {
  refreshGeneratedAt();
  renderInvoice();

  const canGeneratePdf = typeof html2canvas !== "undefined" && window.jspdf && window.jspdf.jsPDF;
  if (!canGeneratePdf) {
    window.print();
    return;
  }

  const room = document.getElementById("room").value || "room";
  const billingMonth = document.getElementById("billingMonth").value || "invoice";
  const filename = `${room}-${billingMonth}`.trim().replace(/\s+/g, "-").toLowerCase() + ".pdf";

  const btn = document.getElementById("printBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Generating PDF...";

  try {
    const printCss = getPrintOnlyCss();
    const canvas = await withTimeout(
      html2canvas(document.getElementById("invoice"), {
        scale: 2,
        useCORS: true,
        logging: false,
        onclone: (clonedDoc) => {
          const style = clonedDoc.createElement("style");
          style.textContent = printCss;
          clonedDoc.head.appendChild(style);
        },
      }),
      20000,
    );
    const imageData = canvas.toDataURL("image/jpeg", 0.98);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    pdf.addImage(imageData, "JPEG", 0, 0, pageWidth, pageHeight);
    pdf.save(filename);
  } catch (error) {
    console.error("PDF generation failed, falling back to print dialog:", error);
    window.print();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

refreshGeneratedAt();
renderInvoice();
