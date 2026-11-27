'use strict';
// Turning dropped files into the text a terminal types for them, the way Terminal.app does it:
// every path with shell-special characters escaped by a backslash, separated by spaces, plus a trailing space.
// Claude Code recognises image paths in that text and attaches the images.
(function (root) {
  const SPECIAL = /([\s'"()[\]{}&;$`\\!*?<>|#~])/g;

  function escapePath(p) {
    return p.replace(SPECIAL, '\\$1');
  }

  function dropText(paths) {
    const list = paths.filter((p) => typeof p === 'string' && p.length);
    return list.length ? list.map(escapePath).join(' ') + ' ' : '';
  }

  // file:// URLs from a text/uri-list drag (some apps give only these, no File objects).
  function pathsFromUriList(text) {
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.startsWith('file://'))
      .map((l) => {
        try {
          return decodeURIComponent(new URL(l).pathname);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
  function isImageName(name) {
    return IMAGE.test(name || '');
  }

  const api = { escapePath, dropText, pathsFromUriList, isImageName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DropPaths = api;
})(typeof window !== 'undefined' ? window : globalThis);
