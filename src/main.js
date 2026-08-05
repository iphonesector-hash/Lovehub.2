// src/main.js
// LoveHub ES-module boot entry (Phase 0).
//
// Loaded from index.html as <script type="module" src="src/main.js">.
// Module scripts run after HTML parsing, so DOM references below are safe.
// Future phases add the router, services, and page modules to this boot
// chain without touching the legacy scripts until each piece is verified.

import { installIcons } from './icons/IconService.js';

installIcons();
