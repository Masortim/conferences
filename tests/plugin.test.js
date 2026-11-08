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

if (jsdomAvailable) {
  setupDom();
  const loaded = loadPluginModule();
  PluginClass = loaded.pluginModule;
  api = PluginClass.__internals;
}

const skip = jsdomAvailable ? false : 'jsdom не установлен — выполните npm install';

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
  return { plugin, app };
}

test('onload регистрирует панель, команды и блок кода', { skip }, async () => {
  const { plugin } = await createPlugin();

  assert.equal(plugin.getEvents().length, 3);
  assert.equal(plugin.views.length, 1);
  assert.equal(plugin.views[0].type, api.VIEW_TYPE);
  assert.deepEqual(
    plugin.commands.map((command) => command.id),
    ['open-panel', 'add-event', 'copy-as-markdown'],
  );
  assert.equal(plugin.codeBlocks.length, 1);
  assert.equal(plugin.codeBlocks[0].language, api.CODE_BLOCK);
  assert.equal(plugin.settingTabs.length, 1);
  assert.equal(plugin.ribbons.length, 1);
  assert.ok(plugin.savedData, 'данные по умолчанию сохранены при первом запуске');
  assert.equal(plugin.savedData.events.length, 3);
  assert.equal(plugin.savedData.settings.openOnStartup, false);
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

test('upsertEvent добавляет и обновляет события', { skip }, async () => {
  const { plugin } = await createPlugin();
  let changes = 0;
  plugin.onChange(() => {
    changes += 1;
  });

  const created = await plugin.upsertEvent({
    title: 'Новая конференция',
    start: '2027-03-01',
    end: '2027-03-02',
    category: 'Конференция',
  });

  assert.ok(created.id);
  assert.equal(plugin.getEvents().length, 4);
  assert.equal(plugin.savedData.events.length, 4);
  assert.equal(changes, 1);

  await plugin.upsertEvent(Object.assign({}, created, { title: 'Обновлённая конференция' }));
  assert.equal(plugin.getEvents().length, 4);
  assert.equal(
    plugin.getEvents().find((event) => event.id === created.id).title,
    'Обновлённая конференция',
  );

  assert.equal(await plugin.upsertEvent({ title: '   ' }), null);
  assert.equal(plugin.getEvents().length, 4);
});

test('persist сохраняет настройки, resetEvents возвращает три события', { skip }, async () => {
  const { plugin } = await createPlugin();

  plugin.settings.showPast = false;
  await plugin.persist();
  assert.equal(plugin.savedData.settings.showPast, false);

  await plugin.upsertEvent({ title: 'Временное событие', start: '2027-04-01' });
  assert.equal(plugin.getEvents().length, 4);

  await plugin.resetEvents();
  assert.equal(plugin.getEvents().length, 3);
  assert.deepEqual(
    plugin.getEvents().map((event) => event.id),
    ['agroneweek', 'technoprom', 'field-day'],
  );
});

test('данные из data.json подхватываются при запуске', { skip }, async () => {
  const { plugin } = await createPlugin({
    initialData: {
      version: 1,
      events: [
        {
          id: 'custom',
          title: 'Своё событие',
          start: '2027-06-01',
          category: 'Выставка',
        },
      ],
      settings: { showPast: false, openOnStartup: true },
    },
  });

  assert.equal(plugin.getEvents().length, 1);
  assert.equal(plugin.getEvents()[0].title, 'Своё событие');
  assert.equal(plugin.settings.showPast, false);
  assert.equal(plugin.settings.openOnStartup, true);
});

test('блок кода подключается как MarkdownRenderChild', { skip }, async () => {
  const { plugin } = await createPlugin();
  const el = document.createElement('div');
  const children = [];
  let rendered = false;

  const handler = plugin.codeBlocks[0].handler;
  handler('view: upcoming', el, {
    addChild(child) {
      children.push(child);
      if (typeof child.onload === 'function') child.onload();
      rendered = true;
    },
  });

  assert.equal(rendered, true);
  assert.equal(children.length, 1);
  assert.ok(el.querySelectorAll('.ct-card').length > 0);
});

test('таблица Markdown для буфера обмена', { skip }, async () => {
  const { plugin } = await createPlugin();
  const table = plugin.buildMarkdownTable();

  assert.match(table, /\| Событие \| Даты \| Место \| Сайт \|/);
  assert.match(table, /Агронеделя/);
  assert.match(table, /10–12 ноября 2026/);
  assert.match(table, /Технопром/);
  assert.match(table, /Дата уточняется \(ориентир: август 2027\)/);
});
