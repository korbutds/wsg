'use strict';

// UI language for what a person reads in the terminal: the interview, CLI messages and ws.
// Workspace files never go through here — they stay English whatever the language is.
// Adding a language is one more catalog file with the same keys as en.js.

const catalogs = { en: require('./en'), ru: require('./ru') };
let lang = 'en';

// WSG_LANG (config, already overridden by the environment in config.load) beats the locale;
// the locale is LC_ALL, then LC_MESSAGES, then LANG, like any POSIX program reads it.
function resolveLang(env = process.env, cfgLang = '') {
  const pick = (v) => {
    const l = String(v || '').trim().toLowerCase().replace(/[.@].*$/, '').split(/[_-]/)[0];
    return Object.hasOwn(catalogs, l) ? l : '';
  };
  if (pick(cfgLang)) return pick(cfgLang);
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return pick(locale) || 'en';
}

function init(l) {
  lang = Object.hasOwn(catalogs, l) ? l : 'en';
  return lang;
}

const current = () => lang;

function lookup(key, l) {
  return catalogs[l][key] ?? catalogs.en[key];
}

// t('key', { name }) — {name} placeholders; a plural entry is an object keyed by CLDR category
// (one/few/many/other) and picked by params.n.
function t(key, params = {}) {
  let value = lookup(key, lang);
  if (value === undefined) return key;
  if (typeof value === 'object') {
    value = value[new Intl.PluralRules(lang).select(Number(params.n))] ?? value.other;
  }
  return value.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// ws is zsh and must not start Node for every message: `wsg shell-init zsh` prints the function
// with @@key@@ placeholders replaced. A placeholder always sits inside a double-quoted zsh string,
// so the text is escaped for that, and {VAR} in a ws.* value becomes the zsh variable ${VAR}.
function renderShell(source, l = lang) {
  const out = source.replace(/@@([\w.]+)@@/g, (m, key) => {
    const value = lookup(key, l);
    if (typeof value !== 'string') throw new Error(`unknown shell string ${key}`);
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/\{(\w+)\}/g, '${$1}');
  });
  if (out.includes('@@')) throw new Error('unrendered placeholder left in the shell function');
  return out;
}

module.exports = { resolveLang, init, current, t, renderShell, catalogs };
