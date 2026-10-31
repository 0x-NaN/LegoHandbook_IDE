const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const mediaDir = path.join(__dirname, '..', 'media');
const dest = path.join(mediaDir, 'mermaid.min.js');

if (!fs.existsSync(src)) {
  console.error(`Error: mermaid.min.js not found at ${src}`);
  process.exit(1);
}

if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

fs.copyFileSync(src, dest);
console.log(`Copied mermaid.min.js to ${dest}`);
