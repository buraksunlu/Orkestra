'use strict';
// The saved workspace: which sessions were open, which were on screen, the layout, recent folders.
const fs = require('fs');

function load(file) {
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      sessions: Array.isArray(w.sessions) ? w.sessions : [],
      ui: w.ui && typeof w.ui === 'object' ? w.ui : {},
      recent: Array.isArray(w.recent) ? w.recent : [],
      limits: w.limits && typeof w.limits === 'object' ? w.limits : null,
      remoteProjects: w.remoteProjects && typeof w.remoteProjects === 'object' ? w.remoteProjects : {},
      catalog: w.catalog && typeof w.catalog === 'object' ? w.catalog : {},
      prefs: w.prefs && typeof w.prefs === 'object' ? w.prefs : {},
      spaces: Array.isArray(w.spaces) ? w.spaces.filter((x) => x && x.id && x.name && Array.isArray(x.members)) : [],
    };
  } catch {
    return { sessions: [], ui: {}, recent: [], limits: null, remoteProjects: {}, catalog: {}, spaces: [], prefs: {} };
  }
}

function save(file, w) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 2));
  fs.renameSync(tmp, file);
}

function addRecent(recent, dir, max = 12) {
  return [dir, ...recent.filter((d) => d !== dir)].slice(0, max);
}

module.exports = { load, save, addRecent };
