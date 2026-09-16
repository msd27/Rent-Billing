const esbuild = require("esbuild");
const { copyFileSync, mkdirSync } = require("fs");

const watch = process.argv.includes("--watch");

mkdirSync("www/fonts", { recursive: true });
mkdirSync("www/tesseract/lang-data", { recursive: true });
copyFileSync("src/index.html", "www/index.html");
copyFileSync("src/styles.css", "www/styles.css");
copyFileSync(
  "node_modules/@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff2",
  "www/fonts/noto-sans-bengali-bengali-400-normal.woff2",
);
copyFileSync(
  "node_modules/@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-700-normal.woff2",
  "www/fonts/noto-sans-bengali-bengali-700-normal.woff2",
);

// Self-host Tesseract.js's worker, WASM core, and English language data so
// OCR works fully offline instead of depending on jsdelivr CDN reachability.
copyFileSync("node_modules/tesseract.js/dist/worker.min.js", "www/tesseract/worker.min.js");
copyFileSync("node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", "www/tesseract/tesseract-core-lstm.wasm.js");
copyFileSync("node_modules/tesseract.js-core/tesseract-core-lstm.wasm", "www/tesseract/tesseract-core-lstm.wasm");
copyFileSync(
  "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "www/tesseract/lang-data/eng.traineddata.gz",
);

const options = {
  entryPoints: ["src/app.js"],
  bundle: true,
  outfile: "www/app.js",
  format: "iife",
  target: "es2019",
  logLevel: "info",
};

if (watch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.build(options);
}
