'use strict';
// What this authority signed, by height, kept on disk: after a restart it still never signs a second block
// at a height where it already signed one. That promise is what makes certified blocks final.
const fs = require('fs');
const path = require('path');

class Votes {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.byHeight = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  get(height) { return this.byHeight[height] || null; }

  // Records the vote on disk before it is sent. Returns false if a different block was already signed here.
  record(height, hash) {
    const prev = this.byHeight[height];
    if (prev) return prev === hash;
    this.byHeight[height] = hash;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.byHeight));
    fs.renameSync(tmp, this.file);
    return true;
  }

  // Heights already certified need no memory (the chain itself prevents a second block there).
  prune(belowOrAt) {
    let changed = false;
    for (const h of Object.keys(this.byHeight)) if (Number(h) <= belowOrAt) { delete this.byHeight[h]; changed = true; }
    if (changed) fs.writeFileSync(this.file, JSON.stringify(this.byHeight));
  }
}

module.exports = { Votes };
