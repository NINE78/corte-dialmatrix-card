// Minimal DOM stubs so the card can be exercised in Node
const path = require('path');
const registry = {};
global.HTMLElement = class {
  constructor() { this._listeners = {}; }
  attachShadow() { this.shadowRoot = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }; return this.shadowRoot; }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; }
};
global.customElements = { define: (n, c) => { registry[n] = c; } };
global.window = {};
global.document = { createElement: (n) => new registry[n]() };
require(path.join(__dirname, '..', 'dialmatrix-card.js'));
const assert = require('assert');
const Card = registry['dialmatrix-card'];
const RoutingEditor = registry['dialmatrix-routing-editor'];
const CardEditor = registry['dialmatrix-card-editor'];

const sw = (id, attrs, state = 'on') => [id, { entity_id: id, state, attributes: attrs }];
const T = (i, id, name) => ({ target_id: id, target_name: name });
const states = Object.fromEntries([
  sw('switch.dialmatrix_front_alice', { event_type: 'doorbell', source_id: 'front', source_name: 'Front Door', doorbell_id: 'front', doorbell_name: 'Front Door', ...T(0,'alice','Alice'), sort_order: [0,0,0] }),
  sw('switch.dialmatrix_front_bob',   { event_type: 'doorbell', source_id: 'front', source_name: 'Front Door', doorbell_id: 'front', doorbell_name: 'Front Door', ...T(1,'bob','Bob'), sort_order: [0,0,1] }, 'off'),
  sw('switch.dialmatrix_driveway_person_alice', { event_type: 'person', source_id: 'driveway', source_name: 'Driveway', camera_id: 'driveway', label: 'person', ...T(0,'alice','Alice'), sort_order: [1,0,0] }),
  sw('switch.dialmatrix_driveway_person_bob',   { event_type: 'person', source_id: 'driveway', source_name: 'Driveway', camera_id: 'driveway', label: 'person', ...T(1,'bob','Bob'), sort_order: [1,0,1] }),
  sw('switch.dialmatrix_driveway_car_alice',    { event_type: 'car', source_id: 'driveway', source_name: 'Driveway', camera_id: 'driveway', label: 'car', ...T(0,'alice','Alice'), sort_order: [2,0,0] }, 'off'),
  sw('switch.dialmatrix_driveway_car_bob',      { event_type: 'car', source_id: 'driveway', source_name: 'Driveway', camera_id: 'driveway', label: 'car', ...T(1,'bob','Bob'), sort_order: [2,0,1] }),
  sw('switch.dialmatrix_garden_alice', { doorbell_id: 'garden', doorbell_name: 'Garden Gate', ...T(0,'alice','Alice') }),
  sw('light.kitchen', { friendly_name: 'Kitchen' }),
]);

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------
const card = new Card();
card.setConfig({ title: 'Routing' });
card.hass = { states, callService: () => {} };
let html = card.shadowRoot.innerHTML;
const idx = (s) => html.indexOf(s);
assert(idx('Doorbells') > -1 && idx('Person detected') > -1 && idx('Car detected') > -1, 'group headers');
assert(idx('Doorbells') < idx('Person detected') && idx('Person detected') < idx('Car detected'), 'group order');
assert(idx('Front Door') < idx('Garden Gate'), 'legacy row after sorted rows');
assert((html.match(/class="btn on"/g) || []).length === 5, 'on count');
assert((html.match(/class="btn off"/g) || []).length === 2, 'off count');
assert((html.match(/class="missing"/g) || []).length === 1, 'garden→bob missing');
assert(html.includes('mdi:walk') && html.includes('mdi:car') && html.includes('mdi:doorbell'), 'icons');
assert(!html.includes('mdi:pencil'), 'no pencil by default');
assert(card.getCardSize() === 4 + 3 + 2, 'card size');

card.setConfig({ event_types: ['car'], group_rows: false, type_labels: { car: 'Vehicles' } });
card.hass = { states, callService: () => {} };
html = card.shadowRoot.innerHTML;
assert(!html.includes('Doorbells') && !html.includes('Vehicles'), 'no group headers when group_rows=false');
assert(html.includes('row-icon') && html.includes('mdi:car') && !html.includes('Front Door'), 'inline icon, doorbell filtered out');
assert((html.match(/class="btn /g) || []).length === 2, 'only car cells');

card.setConfig({});
card.hass = { states, callService: () => {} };
const h1 = card._renderedStateHash;
card.hass = { states, callService: () => {} };
assert.strictEqual(card._renderedStateHash, h1);
card.hass = { states: { ...states, 'switch.dialmatrix_front_bob': { ...states['switch.dialmatrix_front_bob'], state: 'on' } }, callService: () => {} };
assert.notStrictEqual(card._renderedStateHash, h1);
card.hass = { states: { 'light.kitchen': states['light.kitchen'] }, callService: () => {} };
assert(card.shadowRoot.innerHTML.includes('No routing rows yet'));

// Inline pencil when editable
const c1 = new Card(); c1.setConfig({ editable: true }); c1.hass = { states, callService: () => {} };
assert(c1.shadowRoot.innerHTML.includes('mdi:pencil'));
c1._setEditing(true);
assert(c1._editing && c1.shadowRoot.innerHTML.includes('<dialmatrix-routing-editor>') && c1.shadowRoot.innerHTML.includes('mdi:close'));
const before = c1.shadowRoot.innerHTML;
c1.hass = { states: {}, callService: () => {} };
assert.strictEqual(c1.shadowRoot.innerHTML, before, 'no re-render while inline editing');
assert(Card.getConfigElement() instanceof CardEditor, 'config element');

// ---------------------------------------------------------------------------
// Routing editor
// ---------------------------------------------------------------------------
(async () => {
  const stored = {
    doorbells: [{ id: 'defre', name: 'De Fré', mqtt_topic: 'home/doorbell/defre/frigate_event' }],
    cameras: [{ id: 'doorbell', name: 'Doorbell', labels: ['person', 'car'], zones: { person: ['outside_driveway_person'], car: ['outside_driveway_car'] } }],
    targets: [{ id: 'iphone_nik', name: 'Nik', notify_service: 'notify.mobile_app_iphonenik', notify_title: '🔔 Ring', notify_message: '$doorbell_name',
                detect_title: '$icon $label_title detected', detect_message: 'A $label was detected at the $camera_name', notify_data: { url: '/dashboard-iphone/gate', ttl: 0 },
                tts_message: 'x', detect_tts_message: 'y' }],
    frigate: { mqtt: true, mqtt_topic: 'frigate/events', image_url: '/api/frigate/notifications/$event_id/snapshot.jpg' },
  };
  const defaults = { target: { notify_title: '$icon Doorbell', notify_message: 'm', detect_title: 'dt', detect_message: 'dm', notify_data: {}, tts_message: 't', detect_tts_message: 'dtt' },
                     camera: { labels: ['person', 'car'], zones: {} }, frigate: stored.frigate, labels: ['person', 'car'] };
  const wsCalls = [];
  const hass = { states, callService: () => {}, callWS: async (msg) => { wsCalls.push(msg); if (msg.type === 'dialmatrix/config') return { config: stored, configured: true, defaults }; return { config: msg.config }; } };

  const draft = RoutingEditor.toDraft(stored, defaults);
  assert.deepStrictEqual(draft.cameras[0].zones, { person: ['outside_driveway_person'], car: ['outside_driveway_car'] });
  assert.strictEqual(draft.targets[0].tts_entity, '');
  const back = RoutingEditor.fromDraft(draft);
  assert.deepStrictEqual(back.doorbells, stored.doorbells);
  assert.deepStrictEqual(back.cameras, stored.cameras);
  assert.deepStrictEqual(back.targets[0], stored.targets[0], 'empty optional fields dropped');
  assert.deepStrictEqual(back.frigate, stored.frigate);
  assert.deepStrictEqual(RoutingEditor.fromDraft(RoutingEditor.toDraft({ cameras: [{ id: 'a', name: 'A', zones: ['yard'] }] }, defaults)).cameras[0].zones, { person: ['yard'], car: ['yard'] }, 'list zones expanded per label');
  assert.deepStrictEqual(RoutingEditor.fromDraft(RoutingEditor.toDraft({ cameras: [{ id: 'a', name: 'A', zones: { '*': ['yard'], car: ['x'] } }] }, defaults)).cameras[0].zones, { person: ['yard'], car: ['x'] }, 'star zones fill gaps only');
  const bad = (mut, re) => { const d = RoutingEditor.toDraft(stored, defaults); mut(d); assert.throws(() => RoutingEditor.fromDraft(d), re); };
  bad((d) => { d.doorbells[0].id = ''; }, /needs an ID/);
  bad((d) => { d.doorbells[0].id = 'De Fré'; }, /may only contain/);
  bad((d) => { d.targets.push({ ...d.targets[0] }); }, /Duplicate target ID/);
  bad((d) => { d.cameras[0].labels = []; }, /at least one label/);
  bad((d) => { d.doorbells[0].name = ' '; }, /needs a name/);

  const ed = new RoutingEditor();
  ed.hass = hass;
  await new Promise((r) => setImmediate(r));
  assert(ed._draft, 'loaded');
  html = ed.shadowRoot.innerHTML;
  assert(html.includes('data-path="doorbells.0.mqtt_topic"') && html.includes('home/doorbell/defre/frigate_event'), 'doorbell fields');
  assert(html.includes('data-path="cameras.0.zones.person"') && html.includes('outside_driveway_person') && html.includes('data-path="cameras.0.zones.car"'), 'zone fields per label');
  assert(html.includes('data-path="targets.0.notify_data"') && html.includes('&quot;url&quot;'), 'json textarea');
  assert(html.includes('data-path="frigate.mqtt"') && html.includes('checked'), 'mqtt checkbox');
  assert(html.includes('Save routing') && html.includes('$icon'), 'save button + hint');

  ed._onInput({ dataset: { path: 'doorbells.0.name', kind: 'text' }, value: 'De Fré Advocaten' });
  ed._onInput({ dataset: { path: 'cameras.0.labels', kind: 'list' }, value: 'person, car, dog' });
  ed._onInput({ dataset: { path: 'cameras.0.zones.dog', kind: 'list' }, value: ' patio ,yard ' });
  ed._onInput({ dataset: { path: 'frigate.mqtt', kind: 'bool' }, checked: false });
  const ta = { dataset: { path: 'targets.0.notify_data', kind: 'json' }, value: '{bad', classList: { add() { this.c = 'invalid'; }, remove() { this.c = ''; } } };
  ed._onInput(ta); assert(ed._jsonErrors.has('targets.0.notify_data') && ta.classList.c === 'invalid');
  await ed.save(); assert(ed._error.includes('invalid JSON') && !wsCalls.some((m) => m.type === 'dialmatrix/config/save'), 'save blocked on bad json');
  ta.value = '{"url": "/gate", "priority": "high"}'; ed._onInput(ta); assert(!ed._jsonErrors.size);
  ed._onAction({ dataset: { action: 'add-target' } });
  assert.strictEqual(ed._draft.targets.length, 2);
  assert.strictEqual(ed._draft.targets[1].notify_title, '$icon Doorbell', 'defaults from backend');
  ed._onAction({ dataset: { action: 'remove', path: 'targets.1' } });
  assert.strictEqual(ed._draft.targets.length, 1);

  let savedEvent = false; ed.addEventListener('dialmatrix-saved', () => { savedEvent = true; });
  await ed.save();
  const saved = wsCalls.find((m) => m.type === 'dialmatrix/config/save').config;
  assert.strictEqual(saved.doorbells[0].name, 'De Fré Advocaten');
  assert.deepStrictEqual(saved.cameras[0].labels, ['person', 'car', 'dog']);
  assert.deepStrictEqual(saved.cameras[0].zones.dog, ['patio', 'yard']);
  assert.strictEqual(saved.frigate.mqtt, false);
  assert.deepStrictEqual(saved.targets[0].notify_data, { url: '/gate', priority: 'high' });
  assert(savedEvent && ed.shadowRoot.innerHTML.includes('Saved.'), 'saved event + notice');

  ed._hass = { ...hass, callWS: async (m) => { if (m.type === 'dialmatrix/config/save') throw { code: 'invalid_config', message: "duplicate id 'x'" }; return { config: stored, defaults }; } };
  await ed.save();
  assert(ed.shadowRoot.innerHTML.includes('Save failed: duplicate id'));

  const ed2 = new RoutingEditor(); ed2.hass = { callWS: async () => { throw { code: 'unknown_command' }; } };
  await new Promise((r) => setImmediate(r));
  assert(!ed2._draft && ed2.shadowRoot.innerHTML.includes('Could not load') && ed2.shadowRoot.innerHTML.includes('data-action="retry"'));
  const ed3 = new RoutingEditor(); ed3.hass = { callWS: async () => ({ config: {}, configured: false, defaults }) };
  await new Promise((r) => setImmediate(r));
  assert(ed3.shadowRoot.innerHTML.includes('no configuration yet'));

  // ---------------------------------------------------------------------------
  // Card config editor
  // ---------------------------------------------------------------------------
  const ce = new CardEditor();
  const changes = []; ce.addEventListener('config-changed', (ev) => changes.push(ev.detail.config));
  ce.setConfig({ type: 'custom:dialmatrix-card', title: 'Routing' });
  ce.hass = hass;
  assert(ce.shadowRoot.innerHTML.includes('data-option="title"') && ce.shadowRoot.innerHTML.includes('<dialmatrix-routing-editor>'));
  ce._onOption({ dataset: { option: 'title' }, value: '  Calls ' });
  ce._onOption({ dataset: { option: 'event_types', kind: 'list' }, value: 'doorbell, person' });
  ce._onOption({ dataset: { option: 'group_rows', kind: 'bool' }, checked: false });
  ce._onOption({ dataset: { option: 'editable', kind: 'bool' }, checked: true });
  assert.deepStrictEqual(changes.at(-1), { type: 'custom:dialmatrix-card', title: 'Calls', event_types: ['doorbell', 'person'], group_rows: false, editable: true });
  ce._onOption({ dataset: { option: 'group_rows', kind: 'bool' }, checked: true });
  ce._onOption({ dataset: { option: 'editable', kind: 'bool' }, checked: false });
  ce._onOption({ dataset: { option: 'event_types', kind: 'list' }, value: '' });
  ce._onOption({ dataset: { option: 'title' }, value: '' });
  assert.deepStrictEqual(changes.at(-1), { type: 'custom:dialmatrix-card' }, 'defaults dropped from config');

  console.log('CARD_TESTS_OK');
})().catch((e) => { console.error(e); process.exit(1); });
