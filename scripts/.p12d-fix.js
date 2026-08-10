// Phase 12D fix — deadline starvation.
// Replaces the global wall-clock "skipped (deadline)" pre-check with a
// deadline race around the whole pool: every task gets a fair chance to run
// (bounded by its own per-provider timeout), and searchOthers resolves at the
// deadline with whatever completed — a slow provider can never zero out the
// results of healthy providers anymore.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'music-search.js');
let src = fs.readFileSync(FILE, 'utf8');
const report = [];
let ok = true;

function replace(needle, replacement, label) {
    const idx = src.indexOf(needle);
    if (idx === -1) {
        ok = false;
        report.push('MISS: ' + label);
        return;
    }
    src = src.slice(0, idx) + replacement + src.slice(idx + needle.length);
    report.push('OK: ' + label);
}

// 1) Remove the global wall-clock pre-check inside _searchOne.
replace(
    `        async _searchOne(p, variant, t0) {
            const started = Date.now();
            if (Date.now() - t0 > this.config.deadlineMs) {
                this._record(p.id, 0, new Error('skipped (deadline)'));
                return [];
            }
            const diag = this._diag.get(p.id);`,
    `        async _searchOne(p, variant) {
            const started = Date.now();
            // NOTE: no global wall-clock deadline pre-check here. A task that
            // was merely queued behind a slower sibling must still get its
            // chance to run (its own per-provider timeout bounds it); the
            // overall deadline is enforced by a race in searchOthers() that
            // returns whatever completed — one slow provider can no longer
            // zero out the results of every other provider.
            const diag = this._diag.get(p.id);`,
    'remove global deadline pre-check in _searchOne'
);

// 2) searchOthers: schedule tasks with a deadline race (partial results).
replace(
    `        async searchOthers(query, ctx, variants, excludeId) {
            const t0 = Date.now();
            const providers = this.orderedProviders().filter((p) => p.id !== (excludeId || 'internet-archive'));
            const tasks = [];
            providers.forEach((p) => {
                this._pickVariants(p, variants, ctx).forEach((v) => {
                    tasks.push(() => this._searchOne(p, v, t0));
                });
            });
            const settled = tasks.length ? await this._runPool(tasks, this.config.poolLimit) : [];
            return this._mergeDedupe(settled.flat(), providers.map((p) => p.id));
        }`,
    `        async searchOthers(query, ctx, variants, excludeId) {
            const providers = this.orderedProviders().filter((p) => p.id !== (excludeId || 'internet-archive'));
            const tasks = [];
            providers.forEach((p) => {
                this._pickVariants(p, variants, ctx).forEach((v) => {
                    tasks.push(() => this._searchOne(p, v));
                });
            });
            const settled = tasks.length
                ? await this._runPoolDeadline(tasks, this.config.poolLimit, this.config.deadlineMs)
                : [];
            return this._mergeDedupe(settled.flat(), providers.map((p) => p.id));
        }

        // Bounded-concurrency pool that resolves at the deadline with whatever
        // has completed. Every task is still given a fair chance to run (each
        // task is bounded by its own per-provider timeout); if the deadline
        // elapses first, the results collected so far are returned. This keeps
        // the total search time bounded while ensuring a slow/hung provider
        // can never starve the healthy providers out of the result set.
        async _runPoolDeadline(tasks, limit, deadlineMs) {
            const results = new Array(tasks.length);
            let i = 0;
            const workers = Array(Math.max(1, Math.min(limit || POOL_LIMIT, tasks.length))).fill(0).map(async () => {
                while (i < tasks.length) {
                    const idx = i++;
                    results[idx] = await tasks[idx]();
                }
            });
            const completed = Promise.all(workers);
            const deadline = new Promise((resolve) => setTimeout(resolve, deadlineMs || MANAGER_DEADLINE_MS));
            await Promise.race([completed, deadline]);
            return results; // tasks that finished before the deadline
        }`,
    'searchOthers uses _runPoolDeadline'
);

if (!ok) {
    console.error('PATCH FAILED\n' + report.join('\n'));
    process.exit(1);
}
fs.writeFileSync(FILE, src);
console.log('PATCHED\n' + report.join('\n'));
