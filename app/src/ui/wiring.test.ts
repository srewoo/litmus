/**
 * UI wiring-contract test. The DOM controllers (sidepanel.ts / mcpPanel.ts) are
 * excluded from coverage as "DOM glue", so this guards the thing that actually
 * breaks at runtime: a button with no handler (does nothing) or a handler that
 * references an element id that isn't in the HTML (throws on click).
 *
 * It is a static analysis — it parses the real sidepanel.html and the controller
 * sources — so it needs no DOM/browser. It enforces two invariants:
 *   1. No orphan controls: every enabled <button>/<select> with an id in the HTML
 *      is referenced by a handler in the controllers.
 *   2. No dead references: every el()/getElementById()/$() id in the controllers
 *      exists in the HTML, or is rendered dynamically by a view builder.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const html = read('../../public/sidepanel.html');
const controllers = read('./sidepanel.ts') + '\n' + read('./mcpPanel.ts');
const viewBuilders = read('./mcpView.ts') + '\n' + read('./views.ts');

/** Every `id="..."` present in the static HTML. */
const htmlIds = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]!));

/** Ids the controllers look up via el('x') / getElementById('x') / $('x'). */
const referencedIds = new Set(
  [...controllers.matchAll(/(?:el|getElementById|\$)\((["'])([\w-]+)\1\)/g)].map((m) => m[2]!),
);

/** Ids that views inject into the DOM at runtime (so they're not in static HTML). */
const dynamicIds = new Set([...viewBuilders.matchAll(/id=(["'])([\w-]+)\1/g)].map((m) => m[2]!));

/** Enabled, id-bearing <button>/<select> controls in the HTML. */
const controls = [...html.matchAll(/<(button|select)\b([^>]*)>/g)]
  .map((m) => {
    const attrs = m[2]!;
    const id = (attrs.match(/\bid="([\w-]+)"/) ?? [])[1];
    return id ? { id, disabled: /\bdisabled\b/.test(attrs) } : null;
  })
  .filter((c): c is { id: string; disabled: boolean } => c !== null);

describe('UI wiring contract', () => {
  it('has id-bearing controls to check (guards against a broken parse)', () => {
    expect(controls.length).toBeGreaterThan(20);
  });

  it('wires every enabled button/select to a handler (no dead controls)', () => {
    const orphans = controls.filter((c) => !c.disabled && !referencedIds.has(c.id)).map((c) => c.id);
    expect(orphans, `controls present in HTML but never referenced by a handler: ${orphans.join(', ')}`).toEqual([]);
  });

  it('never references an element id that does not exist (no runtime crashes)', () => {
    const dead = [...referencedIds].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
    expect(dead, `el()/getElementById() ids not found in HTML or view output: ${dead.join(', ')}`).toEqual([]);
  });

  it('keeps disabled controls intentionally inert (no handler expected)', () => {
    // Documents the contract: disabled controls (e.g. "coming soon" packs) are
    // allowed to have no handler. If one gains a handler, enable it in the HTML.
    const disabledWithHandler = controls.filter((c) => c.disabled && referencedIds.has(c.id)).map((c) => c.id);
    expect(disabledWithHandler).toEqual([]);
  });
});
