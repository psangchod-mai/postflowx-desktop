'use strict';

/**
 * storage.js — File-based key-value store replacing chrome.storage.local.
 *
 * Stored at: ~/Library/Application Support/PostFlowX/storage.json
 * API mirrors chrome.storage.local: get / set / remove / clear.
 */

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

let _storePath = null;
let _cache     = null;

function _init() {
  if (_storePath) return;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  _storePath = path.join(dir, 'storage.json');
  try {
    _cache = JSON.parse(fs.readFileSync(_storePath, 'utf8'));
  } catch {
    _cache = {};
  }
}

function _flush() {
  try {
    fs.writeFileSync(_storePath, JSON.stringify(_cache), 'utf8');
  } catch (e) {
    console.error('[Storage] flush error:', e.message);
  }
}

/**
 * Get one or more keys. keys may be a string, an array, a defaults object
 * ({ key: defaultValue, ... }), or null/undefined (get all).
 */
function get(keys) {
  _init();
  if (keys == null) return { ..._cache };
  // chrome.storage.local.get() omits keys that were never set rather than
  // including them with an undefined value — callers rely on `'foo' in
  // result` / Object.keys(result).length for presence checks.
  if (typeof keys === 'string') {
    return (keys in _cache) ? { [keys]: _cache[keys] } : {};
  }
  if (Array.isArray(keys)) {
    const result = {};
    for (const k of keys) {
      if (k in _cache) result[k] = _cache[k];
    }
    return result;
  }
  // Defaults-object form: chrome.storage.local.get({ key: defaultValue })
  // returns the stored value if present, else the caller-supplied default.
  const result = {};
  for (const k of Object.keys(keys)) {
    result[k] = (k in _cache) ? _cache[k] : keys[k];
  }
  return result;
}

/** Set one or more key-value pairs. obj is { key: value, ... }. */
function set(obj) {
  _init();
  Object.assign(_cache, obj);
  _flush();
}

/** Remove one key or an array of keys. */
function remove(keys) {
  _init();
  const arr = Array.isArray(keys) ? keys : [keys];
  for (const k of arr) delete _cache[k];
  _flush();
}

/** Clear all stored data. */
function clear() {
  _init();
  _cache = {};
  _flush();
}

module.exports = { get, set, remove, clear };
