const esbuild = require("esbuild");
const { copyFileSync, mkdirSync } = require("fs");

const watch = process.argv.includes("--watch");

mkdirSync("www/fonts", { recursive: true });
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
