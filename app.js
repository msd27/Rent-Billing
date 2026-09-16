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

attachImageInput("currentImage", "currentImagePreview");
attachImageInput("previousImage", "previousImagePreview");
attachImageInput("qrImage", "qrPreview");
attachImageInput("signatureImage", "signaturePreview");

document.getElementById("printBtn").addEventListener("click", () => {
  refreshGeneratedAt();
  renderInvoice();

  if (typeof html2pdf === "undefined") {
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

  html2pdf()
    .set({
      margin: 0,
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "landscape" },
    })
    .from(document.getElementById("invoice"))
    .save()
    .catch(() => window.print())
    .finally(() => {
      btn.disabled = false;
      btn.textContent = originalLabel;
    });
});

refreshGeneratedAt();
renderInvoice();
