'use strict';

const Module = require('module');
const path = require('path');
const { createObsidianStub } = require('./obsidian-stub');

const MAIN_PATH = path.join(__dirname, '..', 'conference-tracker', 'main.js');

/**
 * Загружает main.js плагина, подменяя require('obsidian') на заглушку.
 * Возвращает модуль плагина и использованную заглушку API.
 */
function loadPluginModule() {
  const stub = createObsidianStub();
  const originalLoad = Module._load;
  const originalCache = require.cache[MAIN_PATH];
  delete require.cache[MAIN_PATH];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') return stub;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const pluginModule = require(MAIN_PATH);
    return { pluginModule, obsidian: stub };
  } finally {
    Module._load = originalLoad;
    if (originalCache) require.cache[MAIN_PATH] = originalCache;
  }
}

/** Устанавливает jsdom-окружение и возвращает JSDOM. */
function setupDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.Event = dom.window.Event;
  return dom;
}

module.exports = { loadPluginModule, setupDom, MAIN_PATH };
