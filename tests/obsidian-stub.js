'use strict';

/**
 * Минимальная имитация API Obsidian для юнит- и DOM-тестов плагина.
 * Покрывает только те классы и методы, которые использует main.js.
 */

function createObsidianStub() {
  class TextComponent {
    constructor(parent) {
      this.inputEl = document.createElement('input');
      parent.appendChild(this.inputEl);
    }
    setPlaceholder(value) {
      this.inputEl.placeholder = value;
      return this;
    }
    setValue(value) {
      this.inputEl.value = value == null ? '' : String(value);
      return this;
    }
    getValue() {
      return this.inputEl.value;
    }
    onChange(callback) {
      this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
      this.inputEl.addEventListener('change', () => callback(this.inputEl.value));
      return this;
    }
  }

  function createTextArea(parent) {
    const component = new TextComponent(parent);
    const original = component.inputEl;
    const textarea = document.createElement('textarea');
    original.replaceWith(textarea);
    component.inputEl = textarea;
    return component;
  }

  class DropdownComponent {
    constructor(parent) {
      this.selectEl = document.createElement('select');
      parent.appendChild(this.selectEl);
    }
    addOption(value, label) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.selectEl.appendChild(option);
      return this;
    }
    setValue(value) {
      this.selectEl.value = value;
      return this;
    }
    onChange(callback) {
      this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
      return this;
    }
  }

  class ToggleComponent {
    constructor(parent) {
      this.toggleEl = document.createElement('input');
      this.toggleEl.type = 'checkbox';
      parent.appendChild(this.toggleEl);
    }
    setValue(value) {
      this.toggleEl.checked = !!value;
      return this;
    }
    onChange(callback) {
      this.toggleEl.addEventListener('change', () => callback(this.toggleEl.checked));
      return this;
    }
  }

  class ButtonComponent {
    constructor(parent) {
      this.buttonEl = document.createElement('button');
      parent.appendChild(this.buttonEl);
    }
    setButtonText(text) {
      this.buttonEl.textContent = text;
      return this;
    }
    setCta() {
      this.buttonEl.classList.add('mod-cta');
      return this;
    }
    setWarning() {
      this.buttonEl.classList.add('mod-warning');
      return this;
    }
    onClick(callback) {
      this.buttonEl.addEventListener('click', () => callback());
      return this;
    }
  }

  class Setting {
    constructor(containerEl) {
      this.containerEl = containerEl;
      this.settingEl = document.createElement('div');
      this.settingEl.className = 'setting-item';
      containerEl.appendChild(this.settingEl);

      this.infoEl = document.createElement('div');
      this.infoEl.className = 'setting-item-info';
      this.settingEl.appendChild(this.infoEl);

      this.nameEl = document.createElement('div');
      this.nameEl.className = 'setting-item-name';
      this.infoEl.appendChild(this.nameEl);

      this.descEl = document.createElement('div');
      this.descEl.className = 'setting-item-description';
      this.infoEl.appendChild(this.descEl);

      this.controlEl = document.createElement('div');
      this.controlEl.className = 'setting-item-control';
      this.settingEl.appendChild(this.controlEl);
    }
    setName(value) {
      this.nameEl.textContent = value;
      return this;
    }
    setDesc(value) {
      this.descEl.textContent = value;
      return this;
    }
    setHeading() {
      this.settingEl.classList.add('setting-item-heading');
      return this;
    }
    addText(callback) {
      callback(new TextComponent(this.controlEl));
      return this;
    }
    addTextArea(callback) {
      callback(createTextArea(this.controlEl));
      return this;
    }
    addDropdown(callback) {
      callback(new DropdownComponent(this.controlEl));
      return this;
    }
    addToggle(callback) {
      callback(new ToggleComponent(this.controlEl));
      return this;
    }
    addButton(callback) {
      callback(new ButtonComponent(this.controlEl));
      return this;
    }
  }

  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = document.createElement('div');
      this.titleEl = document.createElement('div');
      this.isOpen = false;
    }
    open() {
      this.isOpen = true;
      if (typeof this.onOpen === 'function') this.onOpen();
    }
    close() {
      this.isOpen = false;
      if (typeof this.onClose === 'function') this.onClose();
    }
  }

  class Notice {
    constructor(message) {
      this.message = message;
      Notice.messages.push(message);
    }
  }
  Notice.messages = [];

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest || { id: 'conference-tracker', dir: '.obsidian/plugins/conference-tracker' };
      this.ribbons = [];
      this.views = [];
      this.commands = [];
      this.codeBlocks = [];
      this.settingTabs = [];
      this.savedData = null;
    }
    addRibbonIcon(icon, title, callback) {
      this.ribbons.push({ icon, title, callback });
      return document.createElement('div');
    }
    registerView(type, factory) {
      this.views.push({ type, factory });
    }
    addSettingTab(tab) {
      this.settingTabs.push(tab);
    }
    addCommand(command) {
      this.commands.push(command);
    }
    registerMarkdownCodeBlockProcessor(language, handler) {
      this.codeBlocks.push({ language, handler });
    }
    registerEvent() {}
    async loadData() {
      return null;
    }
    async saveData(data) {
      this.savedData = JSON.parse(JSON.stringify(data));
    }
  }

  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.containerEl = document.createElement('div');
      this.contentEl = document.createElement('div');
      this.containerEl.appendChild(this.contentEl);
    }
    getViewType() {
      return '';
    }
    getDisplayText() {
      return '';
    }
    getIcon() {
      return '';
    }
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement('div');
    }
  }

  class MarkdownRenderChild {
    constructor(containerEl) {
      this.containerEl = containerEl;
    }
  }

  function setIcon(el, name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'svg-icon');
    svg.setAttribute('data-icon', name);
    el.appendChild(svg);
  }

  class MarkdownRenderer {}

  let requestUrlImpl = async () => {
    throw new Error('requestUrl не настроен в тесте');
  };

  function requestUrl(options) {
    return requestUrlImpl(options);
  }

  requestUrl.setImpl = (implementation) => {
    requestUrlImpl = implementation;
  };

  requestUrl.reset = () => {
    requestUrlImpl = async () => {
      throw new Error('requestUrl не настроен в тесте');
    };
  };

  return {
    Plugin,
    ItemView,
    PluginSettingTab,
    Setting,
    Modal,
    Notice,
    MarkdownRenderChild,
    MarkdownRenderer,
    setIcon,
    requestUrl,
    moment: {},
  };
}

module.exports = { createObsidianStub };
