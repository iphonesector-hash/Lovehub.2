// src/icons/IconService.js
// Phase 0: renders the icon registry into a hidden SVG <symbol> sprite so
// every existing `<use href="#icon-...">` in the markup finally paints.
//
// Same-document <symbol> injection is the standard SVG sprite pattern: once
// installed, the browser re-resolves `<use>` references on the next frame.
// Because this module runs after HTML parsing (module scripts are deferred),
// the sprite exists before the app's first paint of dynamic content.

import { ICONS } from './symbols.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build a <symbol id="icon-{name}"> element from a registry entry.
 */
function buildSymbol(name, def) {
    const symbol = document.createElementNS(SVG_NS, 'symbol');
    symbol.setAttribute('id', `icon-${name}`);
    symbol.setAttribute('viewBox', def.viewBox);

    // Presentation attributes — the legacy markup relies on currentColor
    // inheritance through the .icon-svg class on the referencing <svg>.
    if (def.filled) {
        symbol.setAttribute('fill', 'currentColor');
        symbol.setAttribute('stroke', 'none');
    } else {
        symbol.setAttribute('fill', 'none');
        symbol.setAttribute('stroke', 'currentColor');
        symbol.setAttribute('stroke-width', '2');
        symbol.setAttribute('stroke-linecap', 'round');
        symbol.setAttribute('stroke-linejoin', 'round');
    }
    if (def.extra) {
        for (const [attr, value] of Object.entries(def.extra)) {
            symbol.setAttribute(attr, value);
        }
    }

    symbol.innerHTML = def.body;
    return symbol;
}

/**
 * Install the icon sprite. Safe to call multiple times (idempotent).
 * @returns {SVGSVGElement} the sprite element
 */
export function installIcons() {
    if (document.getElementById('lovehub-icon-sprite')) {
        return document.getElementById('lovehub-icon-sprite');
    }

    const sprite = document.createElementNS(SVG_NS, 'svg');
    sprite.id = 'lovehub-icon-sprite';
    sprite.setAttribute('xmlns', SVG_NS);
    sprite.setAttribute('aria-hidden', 'true');
    sprite.style.cssText = 'display:none;position:absolute;width:0;height:0;overflow:hidden;';

    for (const [name, def] of Object.entries(ICONS)) {
        sprite.appendChild(buildSymbol(name, def));
    }

    document.body.appendChild(sprite);
    return sprite;
}
