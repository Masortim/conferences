'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDom, loadPluginModule } = require('./helpers');

let jsdomAvailable = true;
try {
  require.resolve('jsdom');
} catch (error) {
  jsdomAvailable = false;
}

let PluginClass = null;
let api = null;
let obsidian = null;

if (jsdomAvailable) {
  setupDom();
  const loaded = loadPluginModule();
  PluginClass = loaded.pluginModule;
  api = PluginClass.__internals;
  obsidian = loaded.obsidian;
}

const skip = jsdomAvailable ? false : 'jsdom не установлен — выполните npm install';

const JSON_LD_2027 = `
<html><head><title>Всероссийский день поля 2027</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Event","name":"Всероссийский день поля",
 "startDate":"2027-07-15","endDate":"2027-07-17",
 "location":{"@type":"Place","name":"Сибирский агропарк",
 "address":{"@type":"PostalAddress","addressRegion":"Алтайский край","addressLocality":"пос. Прутской"}}}
</script></head><body><h1>Всероссийский день поля</h1><p>С 15 по 17 июля 2027 года.</p></body></html>`;

function createApp() {
  const leaves = [];
  const app = {
    vault: { configDir: '.obsidian' },
    _layoutReady: null,
    workspace: {
      onLayoutReady(callback) {
        app._layoutReady = callback;
      },
      getLeavesOfType(type) {
        return leaves.filter((leaf) => leaf.viewType === type);
      },
      getRightLeaf() {
        const leaf = {
          viewType: null,
          async setViewState(state) {
            leaf.viewType = state.type;
          },
          detach() {
            leaf.detached = true;
          },
        };
        leaves.push(leaf);
        return leaf;
      },
      getLeaf() {
        return this.getRightLeaf();
      },
      revealLeaf() {},
    },
    _leaves: leaves,
  };
  return app;
}

async function createPlugin(options) {
  const app = createApp();
  const plugin = new PluginClass(app, {
    id: 'conference-tracker',
    dir: '.obsidian/plugins/conference-tracker',
  });
  if (options && options.initialData !== undefined) {
    plugin.loadData = async () => options.initialData;
  }
  await plugin.onload();
  obsidian.Notice.messages.length = 0;
  return { plugin, app };
}

test('onload регистрирует панель, команды, блок кода и данные v2', { skip }, async () => {
  const { plugin } = await createPlugin();

  assert.equal(plugin.getEvents().length, 3);
  assert.equal(plugin.views.length, 1);
  assert.equal(plugin.views[0].type, api.VIEW_TYPE);
  assert.deepEqual(
    plugin.commands.map((command) => command.id),
    ['open-panel', 'add-event', 'sync-events', 'copy-as-markdown'],
  );
  assert.equal(plugin.codeBlocks.length, 1);
  assert.equal(plugin.codeBlocks[0].language, api.CODE_BLOCK);
  assert.equal(plugin.settingTabs.length, 1);
  assert.equal(plugin.ribbons.length, 1);

  assert.ok(plugin.savedData, 'данные по умолчанию сохранены при первом запуске');
  assert.equal(plugin.savedData.version, api.DATA_VERSION);
  assert.equal(plugin.savedData.events.length, 3);
  assert.ok(plugin.savedData.events.every((event) => Array.isArray(event.editions)));
  assert.equal(plugin.savedData.settings.openOnStartup, false);
  assert.equal(plugin.savedData.settings.autoSync, true);

  const fieldDay = plugin.getEvents().find((event) => event.id === 'field-day');
  assert.match(fieldDay.editions[0].place, /Алтайский край/);
});

test('activateView открывает панель один раз', { skip }, async () => {
  const { plugin, app } = await createPlugin();

  const leaf = await plugin.activateView();
  assert.ok(leaf);
  assert.equal(app._leaves.length, 1);
  assert.equal(leaf.viewType, api.VIEW_TYPE);

  const sameLeaf = await plugin.activateView();
  assert.equal(app._leaves.length, 1);
  assert.equal(sameLeaf, leaf);
});

test('upsertEvent добавляет и обновляет события с проведениями', { skip }, async () => {
  const { plugin } = await createPlugin();
  let changes = 0;
  plugin.onChange(() => {
    changes += 1;
  });

  const created = await plugin.upsertEvent({
    title: 'Новая конференция',
    category: 'Конференция',
    editions: [
      { start: '2027-03-01', end: '2027-03-02', place: 'Москва' },
      { start: '2026-03-01', end: '2026-03-02', place: 'Казань' },
    ],
  });

  assert.ok(created.id);
  assert.equal(created.editions.length, 2);
  assert.equal(created.editions[0].start, '2027-03-01');
  assert.equal(plugin.getEvents().length, 4);
  assert.equal(plugin.savedData.events.length, 4);
  assert.equal(changes, 1);

  await plugin.upsertEvent(
    Object.assign({}, created, {
      title: 'Обновлённая конференция',
      editions: [{ start: '2027-03-05', place: 'Москва' }],
    }),
  );
  assert.equal(plugin.getEvents().length, 4);
  const updated = plugin.getEvents().find((event) => event.id === created.id);
  assert.equal(updated.title, 'Обновлённая конференция');
  assert.equal(updated.editions.length, 1);
  assert.equal(updated.editions[0].start, '2027-03-05');

  assert.equal(await plugin.upsertEvent({ title: '   ' }), null);
  assert.equal(plugin.getEvents().length, 4);
});

test('persist сохраняет настройки, resetEvents возвращает события по умолчанию', { skip }, async () => {
  const { plugin } = await createPlugin();

  plugin.settings.showPast = false;
  await plugin.persist();
  assert.equal(plugin.savedData.settings.showPast, false);

  await plugin.upsertEvent({ title: 'Временное событие', editions: [{ start: '2027-04-01' }] });
  assert.equal(plugin.getEvents().length, 4);

  await plugin.resetEvents();
  assert.equal(plugin.getEvents().length, 3);
  assert.deepEqual(
    plugin.getEvents().map((event) => event.id),
    ['agroneweek', 'technoprom', 'field-day'],
  );
  assert.match(obsidian.Notice.messages.at(-1), /восстановлены/);
});

test('данные из data.json v1 мигрируют в проведения', { skip }, async () => {
  const { plugin } = await createPlugin({
    initialData: {
      version: 1,
      events: [
        {
          id: 'custom',
          title: 'Своё событие',
          start: '2027-06-01',
          end: '2027-06-03',
          place: 'Алтай',
          previous: '2026 — 1–3 июня, Москва',
          category: 'Выставка',
        },
      ],
      settings: { showPast: false, openOnStartup: true },
    },
  });

  assert.equal(plugin.getEvents().length, 1);
  const event = plugin.getEvents()[0];
  assert.equal(event.title, 'Своё событие');
  assert.equal(event.editions.length, 1);
  assert.equal(event.editions[0].start, '2027-06-01');
  assert.equal(event.editions[0].place, 'Алтай');
  assert.equal(event.historyNote, '2026 — 1–3 июня, Москва');
  assert.equal(plugin.settings.showPast, false);
  assert.equal(plugin.settings.openOnStartup, true);
});

test('блок кода подключается как MarkdownRenderChild', { skip }, async () => {
  const { plugin } = await createPlugin();
  const el = document.createElement('div');
  const children = [];
  let rendered = false;

  const handler = plugin.codeBlocks[0].handler;
  handler('view: past\nhero: false', el, {
    addChild(child) {
      children.push(child);
      if (typeof child.onload === 'function') child.onload();
      rendered = true;
    },
  });

  assert.equal(rendered, true);
  assert.equal(children.length, 1);
  assert.ok(el.querySelectorAll('.ct-card').length > 0);
  assert.equal(el.querySelectorAll('.ct-hero').length, 0);
});

test('таблица Markdown содержит места и прошлые проведения', { skip }, async () => {
  const { plugin } = await createPlugin();
  const table = plugin.buildMarkdownTable();

  assert.match(table, /\| Событие \| Ближайшее \| Место \| Прошлый раз \|/);
  assert.match(table, /Агронеделя/);
  assert.match(table, /10–12 ноября 2026/);
  assert.match(table, /Технопром/);
  assert.match(table, /Дата уточняется \(ориентир: август 2027\)/);
  assert.match(table, /16–18 июля 2026 · Алтайский край · Сибирский агропарк/);
  assert.match(table, /5–7 ноября 2025 · Новосибирск/);
});

test('fetchPage использует requestUrl и проверяет статус', { skip }, async () => {
  const { plugin } = await createPlugin();
  const seen = [];

  obsidian.requestUrl.setImpl(async (options) => {
    seen.push(options);
    return { status: 200, text: '<html>ok</html>' };
  });

  assert.equal(await plugin.fetchPage('https://example.ru/'), '<html>ok</html>');
  assert.equal(seen[0].url, 'https://example.ru/');
  assert.equal(seen[0].method, 'GET');

  obsidian.requestUrl.setImpl(async () => ({ status: 403, text: '' }));
  await assert.rejects(() => plugin.fetchPage('https://example.ru/'), /HTTP 403/);

  obsidian.requestUrl.setImpl(async () => ({ status: 200 }));
  assert.equal(await plugin.fetchPage('https://example.ru/'), '');

  obsidian.requestUrl.reset();
});

test('syncEventById обновляет событие и сохраняет данные', { skip }, async () => {
  const { plugin } = await createPlugin();
  plugin.fetchPage = async () => JSON_LD_2027;

  const result = await plugin.syncEventById('field-day', true);

  assert.ok(result);
  assert.equal(result.action, 'added');
  const event = plugin.getEvents().find((item) => item.id === 'field-day');
  assert.ok(event.editions.some((edition) => edition.start === '2027-07-15'));
  assert.equal(plugin.settings.lastSyncSummary.includes('новых дат: 1'), true);
  assert.equal(plugin.savedData.events.find((item) => item.id === 'field-day').editions.length, 2);
  assert.match(obsidian.Notice.messages.at(-1), /^День поля: Найдено: 15–17 июля 2027/);
});

test('syncAll обновляет источники и не затирает ручные даты', { skip }, async () => {
  const { plugin } = await createPlugin();
  plugin.fetchPage = async () => JSON_LD_2027;

  const results = await plugin.syncAll({ notify: true });

  assert.equal(results.length, 3);
  const actions = results.map((result) => result.action).sort();
  assert.deepEqual(actions, ['added', 'added', 'conflict']);

  const fieldDay = plugin.getEvents().find((event) => event.id === 'field-day');
  assert.ok(fieldDay.editions.some((edition) => edition.start === '2027-07-15'));

  const technoprom = plugin.getEvents().find((event) => event.id === 'technoprom');
  assert.ok(technoprom.editions.some((edition) => edition.start === '2027-07-15'));

  const agroneweek = plugin.getEvents().find((event) => event.id === 'agroneweek');
  assert.ok(!agroneweek.editions.some((edition) => edition.start === '2027-07-15'));
  assert.match(agroneweek.sync.lastResult, /^На сайте: 15–17 июля 2027/);

  assert.ok(plugin.settings.lastSyncAt);
  assert.match(plugin.settings.lastSyncSummary, /новых дат: 2/);
  assert.match(plugin.settings.lastSyncSummary, /расхождений с сайтом: 1/);
  assert.match(obsidian.Notice.messages.at(-1), /новых дат: 2/);
  assert.ok(plugin.savedData.settings.lastSyncSummary);
});

test('maybeAutoSync соблюдает интервал', { skip }, async () => {
  const { plugin } = await createPlugin();
  let calls = 0;
  plugin.syncAll = async () => {
    calls += 1;
    return [];
  };

  plugin.settings.autoSync = false;
  await plugin.maybeAutoSync();
  assert.equal(calls, 0);

  plugin.settings.autoSync = true;
  plugin.settings.syncIntervalHours = 12;
  plugin.settings.lastSyncAt = new Date().toISOString();
  await plugin.maybeAutoSync();
  assert.equal(calls, 0);

  plugin.settings.lastSyncAt = '2020-01-01T00:00:00.000Z';
  await plugin.maybeAutoSync();
  assert.equal(calls, 1);
});

test('copyAsMarkdown копирует таблицу в буфер обмена', { skip }, async () => {
  const { plugin } = await createPlugin();
  let copied = null;

  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: window.navigator,
  });

  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(value) {
        copied = value;
      },
    },
  });

  await plugin.copyAsMarkdown();
  assert.match(copied, /\| Агронеделя \|/);
  assert.match(obsidian.Notice.messages.at(-1), /скопирован/);

  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText() {
        throw new Error('нет доступа');
      },
    },
  });

  await plugin.copyAsMarkdown();
  assert.match(obsidian.Notice.messages.at(-1), /Не удалось скопировать/);
});
