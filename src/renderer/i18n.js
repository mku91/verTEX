// The interface's words, in the language chosen in Settings (see
// src/locales/*.json and main/locale.js). The catalog comes from the main
// process as the page starts - app.js imports this module first - so that
// everything after it finds the markup already in its words. A change of
// language takes effect on the next start.
//
// A catalog maps a key to a text, where {name} is filled from the params; a
// text that depends on a number is an object of plural forms
// ({ one, few, many, other }), chosen by params.count.
// A key the language lacks is taken from English, a key no one has - as it is.

const { locale, catalog, fallback, languages } = window.vertex.locale.get();
const plurals = new Intl.PluralRules(locale);

export { locale, languages };

export function t(key, params) {
  let text = catalog[key] ?? fallback[key] ?? key;
  if (typeof text === 'object') text = text[plurals.select(params?.count ?? 0)] ?? text.other;
  return params ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole)) : text;
}

// The markup's words: data-i18n="key" - the element's text (an <i18n-text>
// where the element holds more than the text), data-i18n-title="key" and so
// on - its attributes.
const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
export function localize(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const attribute of ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}

document.documentElement.lang = locale;
localize();
