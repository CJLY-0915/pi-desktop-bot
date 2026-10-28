"use strict";
const fs = require("node:fs");
const path = require("node:path");
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function captureFile(input, cwd) {
  if (typeof input !== "string" || !input) return null;
  const file = path.resolve(cwd || process.cwd(), input);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    const text = fs.readFileSync(file, "utf8");
    return text.includes("\0") ? null : { path: file, text };
  } catch (error) {
    return error.code === "ENOENT" ? { path: file, text: "" } : null;
  }
}

function countLineChanges(before, after) {
  if (!before || !after) return null;
  const lines = text => text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  let left = lines(before.text); let right = lines(after.text);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  left = left.slice(prefix, left.length - suffix); right = right.slice(prefix, right.length - suffix);
  if (left.length * right.length > 1000000) return null;
  const row = new Uint32Array(right.length + 1);
  for (const line of left) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j];
      row[j] = line === right[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]);
      diagonal = above;
    }
  }
  return { addedLines: right.length - row[right.length], removedLines: left.length - row[right.length] };
}
module.exports = { captureFile, countLineChanges };
