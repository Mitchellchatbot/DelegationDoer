// Deliberately empty. Turbopack's resolveAlias needs a real file to point at
// (unlike webpack, which accepts `false`), so this stands in for Node-only
// modules that a browser bundle must never pull in — currently pdfjs-dist's
// optional `require('canvas')`, which it only uses when rendering server-side.
module.exports = {};
