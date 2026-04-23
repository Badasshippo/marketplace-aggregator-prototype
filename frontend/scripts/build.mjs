import { copyFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

mkdirSync(dist, { recursive: true });

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const p = join(src, name);
    if (statSync(p).isDirectory()) copyDir(p, join(dest, name));
    else copyFileSync(p, join(dest, name));
  }
}

copyDir(join(root, "public"), dist);
console.log("Built frontend -> dist/");
