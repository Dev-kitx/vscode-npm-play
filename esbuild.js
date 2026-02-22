// esbuild.js
const esbuild = require("esbuild");
const path = require("path");

const isWatch = process.argv.includes("--watch");

const common = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "dist/extension.js",
  sourcemap: true,
  external: ["vscode"], // MUST be external in VS Code extensions
  logLevel: "info"
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(common);
    await ctx.watch();
    console.log("🔁 esbuild watching...");
  } else {
    await esbuild.build(common);
    console.log("✅ esbuild build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
