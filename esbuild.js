const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  sourcemap: !production,
  minify: production,
  external: ["vscode"]
};

async function main() {
  const context = await esbuild.context(options);
  if (watch) {
    await context.watch();
    console.log("[mimocode] extension build is watching");
    return;
  }
  await context.rebuild();
  await context.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

