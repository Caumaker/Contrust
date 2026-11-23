'use strict';
// Append-only file with one block per line (JSON Lines). Replacing the chain after a fork writes a new file and renames it.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
      try { return JSON.parse(line); } catch (e) { throw new Error(`${this.file}: line ${i + 1} is not valid JSON`); }
    });
  }

  append(block) {
    fs.appendFileSync(this.file, JSON.stringify(block) + '\n');
  }

  replace(blocks) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, blocks.map((b) => JSON.stringify(b)).join('\n') + '\n');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
