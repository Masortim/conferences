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
    async syncAll() {
      this.syncAllCalls = (this.syncAllCalls || 0) + 1;
      return [];
    },
    async syncEventById(id) {
      this.syncedId = id;
      return null;
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

function cardByTitle(root, title) {
  return cards(root).find(
    (card) => card.querySelector('.ct-card-title').textContent === title,
  );
}

function metaTexts(card) {
  return Array.from(card.querySelectorAll('.ct-meta-text')).map((node) => node.textContent);
}

function findButton(root, text) {
  return Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === text,
  );
}

test('виджет рисует ближайшее событие, места и прошлые проведения', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin();
  api.renderWidget(root, plugin, { now: NOW });

  const hero = root.querySelector('.ct-hero');
  assert.ok(hero, 'блок ближайшего события отрисован');
  assert.equal(hero.querySelector('.ct-hero-title').textContent, 'Агронеделя');
  assert.equal(hero.querySelector('.ct-hero-num').textContent, '2');
  assert.match(hero.querySelector('.ct-hero-date').textContent, /10–12 ноября 2026/);
  assert.match(hero.querySelector('.ct-hero-place').textContent, /Новосибирск/);

  const items = cards(root);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((card) => card.querySelector('.ct-card-title').textContent),
    ['Агронеделя', 'День поля', 'Технопром'],
  );
  assert.deepEqual(
    items.map((card) => card.querySelector('.ct-badge').textContent),
    ['Через 2 дня', 'Дата уточняется', 'Дата уточняется'],
  );

  const fieldDay = cardByTitle(root, 'День поля');
  const fieldDayMeta = metaTexts(fieldDay);
  assert.equal(fieldDayMeta[0], 'Ориентир: июль 2027');
  assert.equal(fieldDayMeta[1], 'Место уточняется');
  assert.equal(
    fieldDayMeta[2],
    'Прошлый раз: 16–18 июля 2026 · Алтайский край · Сибирский агропарк, пос. Прутской',
  );

  // Показывается только одно актуальное прошлое проведение — без архива.
  assert.equal(fieldDay.querySelector('.ct-history'), null);

  const agroneweek = cardByTitle(root, 'Агронеделя');
  const agroneweekMeta = metaTexts(agroneweek);
  assert.equal(agroneweekMeta[0], '10–12 ноября 2026');
  assert.match(agroneweekMeta[1], /Новосибирск/);
  assert.equal(
    agroneweekMeta[2],
    'Прошлый раз: 5–7 ноября 2025 · Новосибирск · МВК «Новосибирск Экспоцентр»',
  );

  const technoprom = cardByTitle(root, 'Технопром');
  assert.match(
    metaTexts(technoprom)[2],
    /Прошлый раз: 26–28 августа 2026 · Новосибирск/,
  );

  const tabs = Array.from(root.querySelectorAll('.ct-tab'));
  assert.deepEqual(
    tabs.map((tab) => tab.dataset.mode),
    ['upcoming', 'all', 'past'],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.querySelector('.ct-tab-count').textContent),
    ['3', '3', '3'],
  );
});

test('вкладка «Прошедшие» показывает архив с местами проведения', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin();
  api.renderWidget(root, plugin, { now: NOW });

  root.querySelector('.ct-tab[data-mode="past"]').click();

  const items = cards(root);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((card) => card.querySelector('.ct-card-title').textContent),
    ['Технопром', 'День поля', 'Агронеделя'],
  );

  const fieldDay = cardByTitle(root, 'День поля');
  assert.match(metaTexts(fieldDay)[0], /16–18 июля 2026/);
  assert.match(metaTexts(fieldDay)[1], /Алтайский край/);
  assert.match(fieldDay.querySelector('.ct-badge').textContent, /^Завершилось/);
  assert.equal(fieldDay.querySelector('.ct-meta--past'), null);

  assert.equal(fieldDay.querySelector('.ct-history'), null);
  assert.equal(fieldDay.querySelector('.ct-meta--past'), null);
});

test('настройки скрывают прошедшие и неуточнённые события', { skip }, () => {
  const root = container();
  const plugin = createFakePlugin();
  plugin.settings.showPast = false;
  plugin.settings.showHero = false;

  api.renderWidget(root, plugin, { now: NOW });

  assert.equal(root.querySelector('.ct-hero'), null);
  assert.deepEqual(
    Array.from(root.querySelectorAll('.ct-tab')).map((tab) => tab.dataset.mode),
    ['upcoming', 'all'],
  );
  assert.equal(cards(root).length, 3);

  const root2 = container();
  const plugin2 = createFakePlugin();
  plugin2.settings.showTentative = false;
  api.renderWidget(root2, plugin2, { now: NOW });
  assert.equal(cards(root2).length, 1);
  assert.equal(cards(root2)[0].querySelector('.ct-card-title').textContent, 'Агронеделя');
});

test('автоматически найденные даты помечаются, конфликты показываются', { skip }, () => {
  const autoEvent = api.normalizeEvent({
    id: 'auto',
    title: 'Автособытие',
    category: 'Выставка',
    editions: [
      {
        start: '2027-05-05',
        end: '2027-05-06',
        place: 'Москва · Экспоцентр',
        source: 'auto',
        checkedAt: '2026-11-08T10:00:00.000Z',
        sourceUrl: 'https://example.ru/',
      },
    ],
    sync: { sources: ['https://example.ru/'], lastSync: '2026-11-08T10:00:00.000Z' },
  });
  autoEvent.sync.lastResult = 'На сайте: 5–6 мая 2027 · Москва · Экспоцентр';

  const root = container();
  api.renderWidget(root, createFakePlugin([autoEvent]), { now: NOW });

  const card = cardByTitle(root, 'Автособытие');
  const autoChip = card.querySelector('.ct-chip--auto');
  assert.ok(autoChip);
  assert.equal(autoChip.textContent, 'авто');
  assert.match(autoChip.title, /получены с сайта/);

  const conflict = card.querySelector('.ct-sync-conflict');
  assert.ok(conflict);
  assert.match(conflict.textContent, /^На сайте: 5–6 мая 2027/);
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

test('боковая панель обновляется при изменении данных', { skip }, async () => {
  const plugin = createFakePlugin();
  const view = new api.ConferenceTrackerView({ app: {} }, plugin);
  await view.onOpen();

  assert.equal(view.contentEl.querySelectorAll('.ct-card').length, 3);

  plugin.data.events.push(
    api.normalizeEvent({ id: 'new', title: 'Новая конференция', editions: [{ start: '2027-03-01' }] }),
  );
  plugin.notify();
  assert.equal(view.contentEl.querySelectorAll('.ct-card').length, 4);

  await view.onClose();
  plugin.data.events.push(
    api.normalizeEvent({ id: 'new-2', title: 'Ещё одна', editions: [{ start: '2027-04-01' }] }),
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
    api.normalizeEvent({ id: 'extra', title: 'Дополнительно', editions: [{ start: '2027-02-02' }] }),
  );
  plugin.notify();
  assert.equal(el.querySelectorAll('.ct-card').length, 4);
  assert.equal(el.querySelectorAll('.ct-widget').length, 1);

  child.onunload();
  plugin.data.events.push(
    api.normalizeEvent({ id: 'extra-2', title: 'Ещё', editions: [{ start: '2027-02-03' }] }),
  );
  plugin.notify();
  assert.equal(el.querySelectorAll('.ct-card').length, 4);
});

test('модальное окно редактирует дату, место и историю', { skip }, async () => {
  const calls = [];
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin);
  modal.open();
  assert.equal(modal.titleEl.textContent, 'Новое событие');
  assert.equal(modal.tentative, false);

  const titleInput = modal.contentEl.querySelector('input[placeholder="Например, Технопром"]');
  titleInput.value = 'Агрофорум';
  titleInput.dispatchEvent(new window.Event('input'));

  const dateInputs = modal.contentEl.querySelectorAll('input[type="date"]');
  dateInputs[0].value = '2027-03-15';
  dateInputs[0].dispatchEvent(new window.Event('input'));
  dateInputs[1].value = '2027-03-17';
  dateInputs[1].dispatchEvent(new window.Event('input'));

  const placeInput = modal.contentEl.querySelector('input[placeholder="Например, Алтайский край · Сибирский агропарк"]');
  placeInput.value = 'Москва · Экспоцентр';
  placeInput.dispatchEvent(new window.Event('input'));

  await modal.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Агрофорум');
  assert.equal(calls[0].editions.length, 1);
  assert.equal(calls[0].editions[0].start, '2027-03-15');
  assert.equal(calls[0].editions[0].end, '2027-03-17');
  assert.equal(calls[0].editions[0].place, 'Москва · Экспоцентр');
  assert.equal(calls[0].expectedMonth, '');
  assert.equal(modal.isOpen, false);
  assert.ok(obsidian.Notice.messages.includes('Событие добавлено'));
});

test('режим «Дата уточняется» сохраняет ориентир без проведения', { skip }, async () => {
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
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change'));

  const monthInput = modal.contentEl.querySelector('input[type="month"]');
  monthInput.value = '2027-08';
  monthInput.dispatchEvent(new window.Event('input'));

  await modal.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].editions.length, 0);
  assert.equal(calls[0].expectedMonth, '2027-08');
});

test('история в модальном окне: добавление, удаление и сохранение', { skip }, async () => {
  const calls = [];
  const events = api.normalizeData(null).events;
  const agroneweek = events.find((event) => event.id === 'agroneweek');
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin, agroneweek);
  modal.open();

  assert.equal(modal.tentative, false);
  assert.equal(modal.nextStart, '2026-11-10');
  assert.equal(modal.history.length, 1);
  assert.equal(modal.contentEl.querySelectorAll('.ct-history-row').length, 1);

  findButton(modal.contentEl, '+ Добавить проведение').click();
  assert.equal(modal.contentEl.querySelectorAll('.ct-history-row').length, 2);

  const lastRow = modal.contentEl.querySelectorAll('.ct-history-row')[1];
  const lastDates = lastRow.querySelectorAll('input[type="date"]');
  lastDates[0].value = '2023-11-08';
  lastDates[0].dispatchEvent(new window.Event('input'));
  lastDates[1].value = '2023-11-10';
  lastDates[1].dispatchEvent(new window.Event('input'));
  const lastPlace = lastRow.querySelector('input[type="text"]');
  lastPlace.value = 'Новосибирск';
  lastPlace.dispatchEvent(new window.Event('input'));

  await modal.save();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].editions.length, 3);
  assert.equal(calls[0].expectedMonth, '2027-11');
  assert.ok(calls[0].editions.some((edition) => edition.start === '2023-11-08'));

  const modal2 = new api.EventModal({}, plugin, agroneweek);
  modal2.open();
  modal2.contentEl.querySelectorAll('.ct-history-row')[0].querySelector('button').click();
  assert.equal(modal2.contentEl.querySelectorAll('.ct-history-row').length, 0);

  await modal2.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].editions.length, 1);
});

test('форма не показывает и не сохраняет проведения вне разрешённых регионов', { skip }, async () => {
  const calls = [];
  const event = api.normalizeEvent({
    id: 'field-day',
    title: 'День поля',
    regions: ['Алтай'],
    editions: [
      { start: '2026-07-16', end: '2026-07-18', place: 'Алтайский край · Сибирский агропарк' },
      { start: '2025-07-03', end: '2025-07-05', place: 'Волгоградская область · КФХ «Чердынцев»' },
    ],
  });
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin, event);
  modal.open();

  assert.equal(modal.contentEl.querySelectorAll('.ct-history-row').length, 1);
  assert.match(
    modal.contentEl.querySelector('.ct-history-row input[type="text"]').value,
    /Алтайский край/,
  );

  // Пробуем добавить будущее проведение в чужом регионе — форма не сохраняет.
  const toggle = modal.contentEl.querySelector('input[type="checkbox"]');
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change'));

  const dateInputs = modal.contentEl.querySelectorAll('input[type="date"]');
  dateInputs[0].value = '2027-07-15';
  dateInputs[0].dispatchEvent(new window.Event('input'));

  const placeInput = modal.contentEl.querySelector(
    'input[placeholder="Например, Алтайский край · Сибирский агропарк"]',
  );
  placeInput.value = 'Омская область · Экспоцентр';
  placeInput.dispatchEvent(new window.Event('input'));

  await modal.save();
  assert.equal(calls.length, 0);
  assert.ok(
    Array.from(modal.contentEl.querySelectorAll('.ct-error')).some((node) =>
      node.textContent.includes('вне разрешённых регионов'),
    ),
  );

  placeInput.value = 'Алтайский край · Сибирский агропарк';
  placeInput.dispatchEvent(new window.Event('input'));

  await modal.save();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].regions, ['Алтай']);
  assert.equal(calls[0].editions.length, 2);
  assert.ok(calls[0].editions.some((edition) => edition.start === '2027-07-15'));
});

test('модальное окно не сохраняет дубли дат', { skip }, async () => {
  const calls = [];
  const events = api.normalizeData(null).events;
  const agroneweek = events.find((event) => event.id === 'agroneweek');
  const plugin = createFakePlugin();
  plugin.upsertEvent = async (payload) => {
    calls.push(payload);
  };

  const modal = new api.EventModal({}, plugin, agroneweek);
  modal.open();
  modal.history[0].start = modal.nextStart;
  modal.renderHistoryRows();

  await modal.save();
  assert.equal(calls.length, 0);
  const errors = Array.from(modal.contentEl.querySelectorAll('.ct-error')).map(
    (node) => node.textContent,
  );
  assert.ok(errors.some((message) => message.includes('уже указана')));

  const modal2 = new api.EventModal({}, plugin);
  modal2.open();
  await modal2.save();
  const errors2 = Array.from(modal2.contentEl.querySelectorAll('.ct-error')).map(
    (node) => node.textContent,
  );
  assert.ok(errors2.some((message) => message.includes('Укажите название')));
  assert.equal(calls.length, 0);
});
