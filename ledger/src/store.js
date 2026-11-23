'use strict';
// Append-only file with one block per line (JSON Lines). Blocks are written BEFORE they enter the chain in memory,
// so a failed write never leaves a hole. A last line cut by a power loss is dropped (it was never confirmed).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, log = () => {}) {
    this.file = file;
    this.log = log;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        blocks.push(JSON.parse(lines[i]));
      } catch (e) {
        const isLast = lines.slice(i + 1).every((l) => !l);
        if (!isLast) throw new Error(`${this.file}: line ${i + 1} is not valid JSON`);
        const keep = lines.slice(0, i).join('\n') + (i ? '\n' : '');
        fs.writeFileSync(this.file, keep);
        this.log(`dropped an incomplete last line in ${this.file} (interrupted write)`);
      }
    }
    return blocks;
  }

  append(block) {
    fs.appendFileSync(this.file, JSON.stringify(block) + '\n');
  }
}

module.exports = { Store };
