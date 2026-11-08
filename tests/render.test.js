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

let api = null;
let obsidian = null;

if (jsdomAvailable) {
  setupDom();
  const loaded = loadPluginModule();
  api = loaded.pluginModule.__internals;
  obsidian = loaded.obsidian;
}

const NOW = api ? api.todayDayNumber(new Date(2026, 10, 8)) : 0;
const skip = jsdomAvailable ? false : 'jsdom не установлен — выполните npm install';

function createFakePlugin(events) {
  const listeners = new Set();
  const settings = Object.assign({}, api.DEFAULT_SETTINGS);
  return {
    data: {
      events: events || api.normalizeData(null).events,
      settings,
    },
    settings,
    getEvents() {
      return this.data.events;
    },
    getSettings() {
      return this.settings;
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    notify() {
      Array.from(listeners).forEach((callback) => callback());
    },
    openEventModal(event) {
      this.openCount = (this.openCount || 0) + 1;
      this.openedEvent = event || null;
    },
    deleteEvent(event) {
      this.deletedEvent = event;
    },
  };
}

function container() {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return node;
}

function cards(root) {
  return Array.from(root.querySelectorAll('.ct-card'));
}

test('виджет рисует ближайшее событие и карточки', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin();
  api.renderWidget(root, plugin, { now: NOW, ...{} });

  assert.equal(root.querySelectorAll('.ct-widget').length, 1);

  const hero = root.querySelector('.ct-hero');
  assert.ok(hero, 'блок ближайшего события отрисован');
  assert.equal(hero.querySelector('.ct-hero-title').textContent, 'Агронеделя');
  assert.equal(hero.querySelector('.ct-hero-num').textContent, '2');
  assert.match(hero.querySelector('.ct-hero-date').textContent, /10–12 ноября 2026/);

  const items = cards(root);
  assert.equal(items.length, 3);

  const badges = items.map((card) => card.querySelector('.ct-badge').textContent);
  assert.deepEqual(badges, ['Через 2 дня', 'Дата уточняется', 'Дата уточняется']);

  const dates = items.map((card) => card.querySelector('.ct-meta-text').textContent);
  assert.equal(dates[0], '10–12 ноября 2026');
  assert.equal(dates[1], 'Ориентир: июль 2027');
  assert.equal(dates[2], 'Ориентир: август 2027');

  const technoprom = items.find(
    (card) => card.querySelector('.ct-card-title').textContent === 'Технопром',
  );
  const link = technoprom.querySelector('.ct-link');
  assert.equal(link.getAttribute('href'), 'https://форумтехнопром.рф/');
  assert.equal(link.target, '_blank');

  const tabs = Array.from(root.querySelectorAll('.ct-tab'));
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.mode),
    ['upcoming', 'all', 'past'],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.querySelector('.ct-tab-count').textContent),
    ['3', '3', '0'],
  );
  assert.equal(root.querySelector('.ct-tab.is-active').dataset.mode, 'upcoming');
});

test('вкладки переключают список и показывают пустое состояние', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin([
    ...api.normalizeData(null).events,
    api.normalizeEvent({ id: 'past', title: 'Прошлая выставка', start: '2026-11-01', end: '2026-11-02' }),
  ]);

  api.renderWidget(root, plugin, { now: NOW });
  assert.equal(cards(root).length, 3);

  root.querySelector('.ct-tab[data-mode="past"]').click();
  assert.equal(cards(root).length, 1);
  assert.equal(cards(root)[0].querySelector('.ct-card-title').textContent, 'Прошлая выставка');
  assert.equal(cards(root)[0].querySelector('.ct-badge').textContent, 'Завершилось 6 дней назад');

  root.querySelector('.ct-tab[data-mode="upcoming"]').click();
  assert.equal(cards(root).length, 3);
});

test('пустой список подсказывает добавить событие', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin([]);
  api.renderWidget(root, plugin, { now: NOW });

  const empty = root.querySelector('.ct-empty');
  assert.ok(empty);
  assert.match(empty.textContent, /Предстоящих событий нет/);

  root.querySelector('.ct-primary-btn').click();
  assert.equal(plugin.openCount, 1);
});

test('настройки скрывают прошедшие события и блок «Ближайшее»', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin([
    api.normalizeEvent({ id: 'past', title: 'Прошлое', start: '2026-11-01' }),
    api.normalizeEvent({ id: 'future', title: 'Будущее', start: '2027-05-05' }),
  ]);
  plugin.settings.showPast = false;
  plugin.settings.showHero = false;

  api.renderWidget(root, plugin, { now: NOW });

  assert.equal(root.querySelector('.ct-hero'), null);
  assert.deepEqual(
    Array.from(root.querySelectorAll('.ct-tab')).map((tab) => tab.dataset.mode),
    ['upcoming', 'all'],
  );
  assert.equal(cards(root).length, 1);
});

test('настройка showTentative убирает события без даты', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin();
  plugin.settings.showTentative = false;

  api.renderWidget(root, plugin, { now: NOW });
  assert.equal(cards(root).length, 1);
  assert.equal(cards(root)[0].querySelector('.ct-card-title').textContent, 'Агронеделя');
});

test('боковая панель обновляется при изменении данных', { skip }, async () => {
  const plugin = createFakePlugin();
  const leaf = { app: {} };
  const view = new api.ConferenceTrackerView(leaf, plugin);
  await view.onOpen();

  assert.equal(view.contentEl.querySelectorAll('.ct-card').length, 3);

  plugin.data.events.push(
    api.normalizeEvent({ id: 'new', title: 'Новая конференция', start: '2027-03-01' }),
  );
  plugin.notify();
  assert.equal(view.contentEl.querySelectorAll('.ct-card').length, 4);

  await view.onClose();
  plugin.data.events.push(
    api.normalizeEvent({ id: 'new-2', title: 'Ещё одна', start: '2027-04-01' }),
  );
  plugin.notify();
  assert.equal(view.contentEl.querySelectorAll('.ct-card').length, 4);
  assert.equal(view.getViewType(), api.VIEW_TYPE);
  assert.equal(view.getDisplayText(), 'Конференции');
});

test('блок ```conferences``` встраивает виджет в заметку', { skip }, () => {
  const el = container();
  const plugin = createFakePlugin();
  const child = new api.ConferenceCodeBlock(el, plugin, { view: 'all', compact: false });

  child.onload();
  assert.equal(el.querySelectorAll('.ct-card').length, 3);
  assert.equal(el.querySelector('.ct-header'), null);
  assert.ok(el.querySelector('.ct-hero'));

  plugin.data.events.push(
    api.normalizeEvent({ id: 'extra', title: 'Дополнительно', start: '2027-02-02' }),
  );
  plugin.notify();
  assert.equal(el.querySelectorAll('.ct-card').length, 4);
  assert.equal(el.querySelectorAll('.ct-widget').length, 1);

  child.onunload();
  plugin.data.events.push(
    api.normalizeEvent({ id: 'extra-2', title: 'Ещё', start: '2027-02-03' }),
  );
  plugin.notify();
  assert.equal(el.querySelectorAll('.ct-card').length, 4);
});

test('модальное окно валидирует и сохраняет событие', { skip }, async () => {
  const calls = [];
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin);
  modal.open();
  assert.equal(modal.titleEl.textContent, 'Новое событие');

  await modal.save();
  assert.equal(calls.length, 0);
  assert.ok(modal.contentEl.querySelector('.ct-error'));

  const titleInput = modal.contentEl.querySelector('input[placeholder="Например, Технопром"]');
  assert.ok(titleInput);
  titleInput.value = 'Агрофорум';
  titleInput.dispatchEvent(new window.Event('input'));

  const dateInput = modal.contentEl.querySelector('input[type="date"]');
  dateInput.value = '2027-03-15';
  dateInput.dispatchEvent(new window.Event('input'));

  await modal.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Агрофорум');
  assert.equal(calls[0].start, '2027-03-15');
  assert.equal(calls[0].expectedMonth, '');
  assert.equal(modal.isOpen, false);
  assert.ok(obsidian.Notice.messages.includes('Событие добавлено'));
});

test('режим «Дата уточняется» сохраняет ориентировочный месяц', { skip }, async () => {
  const calls = [];
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin);
  modal.open();

  const titleInput = modal.contentEl.querySelector('input[placeholder="Например, Технопром"]');
  titleInput.value = 'Технопром';
  titleInput.dispatchEvent(new window.Event('input'));

  const toggle = modal.contentEl.querySelector('input[type="checkbox"]');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change'));

  const monthInput = modal.contentEl.querySelector('input[type="month"]');
  monthInput.value = '2027-08';
  monthInput.dispatchEvent(new window.Event('input'));

  await modal.save();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Технопром');
  assert.equal(calls[0].start, '');
  assert.equal(calls[0].end, '');
  assert.equal(calls[0].expectedMonth, '2027-08');
  assert.equal(calls[0].tentative, true);
});

test('без даты и без режима «Дата уточняется» форма не сохраняет', { skip }, async () => {
  const calls = [];
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin);
  modal.open();

  const titleInput = modal.contentEl.querySelector('input[placeholder="Например, Технопром"]');
  titleInput.value = 'Без даты';
  titleInput.dispatchEvent(new window.Event('input'));

  await modal.save();

  assert.equal(calls.length, 0);
  const messages = Array.from(modal.contentEl.querySelectorAll('.ct-error')).map(
    (node) => node.textContent,
  );
  assert.ok(messages.some((message) => message.includes('Укажите дату начала')));
  assert.equal(modal.isOpen, true);
});
