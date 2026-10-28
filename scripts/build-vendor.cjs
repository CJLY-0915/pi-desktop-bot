"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { build } = require("esbuild");
const root = path.resolve(__dirname, "..");

// 打包入口源码显式列出：入口只接受字面量 require，动态拼接会被插件中心审计判为动态模块加载。
const BUNDLES = [
  { name: "qrcode", contents: 'module.exports = require("qrcode");' },
  { name: "feishu", contents: 'module.exports = require("@larksuiteoapi/node-sdk");' },
  { name: "dingtalk", contents: 'module.exports = require("dingtalk-stream");' },
];

async function main() {
  const packages = new Map();
  for (const { name, contents } of BUNDLES) {
    const result = await build({
      absWorkingDir: root,
      stdin: { contents, resolveDir: root },
      outfile: path.join(root, "vendor", `${name}.cjs`),
      bundle: true, platform: "node", format: "cjs", target: "node18", minify: true,
      legalComments: "inline", metafile: true,
      // ws treats these native accelerators as optional and handles their absence.
      external: ["bufferutil", "utf-8-validate"],
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!input.includes("node_modules/")) continue;
      let dir = path.dirname(path.resolve(root, input));
      while (dir !== root && dir !== path.dirname(dir)) {
        const manifestPath = path.join(dir, "package.json");
        if (fs.existsSync(manifestPath)) {
          const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (pkg.name && pkg.version) { packages.set(dir, pkg); break; }
        }
        dir = path.dirname(dir);
      }
    }
  }
  const notices = [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([dir, pkg]) => {
    const licenses = fs.readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
    if (!licenses.length && fs.existsSync(path.join(dir, "README.md"))) {
      const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
      const match = readme.match(/(?:^|\n)(?:#+\s*)?License\s*\r?\n(?:[-=]+\s*\r?\n)?([\s\S]*)/i);
      if (match && /copyright/i.test(match[1])) return `${pkg.name} ${pkg.version} (${pkg.license})\n\n${match[1]}`;
    }
    if (!licenses.length) throw new Error(`License file missing: ${pkg.name}`);
    return [`${pkg.name} ${pkg.version} (${pkg.license || "see license"})`, ...licenses.map(name => fs.readFileSync(path.join(dir, name), "utf8"))].join("\n\n");
  });
  fs.writeFileSync(path.join(root, "vendor", "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n====================\n\n"), "utf8");
  console.log(`Bundled 3 runtime dependencies; notices for ${packages.size} packages.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
