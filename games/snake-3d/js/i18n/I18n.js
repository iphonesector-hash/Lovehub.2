/**
 * i18n manager — supports EN / FA + LTR / RTL
 */

import { translations, t as translate } from './translations.js';

export class I18n {
  constructor() {
    this.lang = this._detectLang();
    this.listeners = new Set();
  }

  _detectLang() {
    const saved = localStorage.getItem('snake3d_lang');
    if (saved === 'fa' || saved === 'en') return saved;
    const nav = (navigator.language || 'en').toLowerCase();
    return nav.startsWith('fa') || nav.startsWith('ar') ? 'fa' : 'en';
  }

  get language() {
    return this.lang;
  }

  get dir() {
    return this.lang === 'fa' ? 'rtl' : 'ltr';
  }

  setLanguage(lang) {
    if (lang !== 'en' && lang !== 'fa') return;
    this.lang = lang;
    localStorage.setItem('snake3d_lang', lang);
    this.apply();
    this.listeners.forEach((fn) => fn(lang));
  }

  t(key) {
    return translate(key, this.lang);
  }

  apply() {
    document.documentElement.lang = this.lang;
    document.documentElement.dir = this.dir;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = this.t(key);
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
