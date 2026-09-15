/**
 * Dial Matrix Card — custom Lovelace card for Home Assistant
 * Renders a visual event-routing matrix and toggles switch entities.
 *
 * Rows are event sources: doorbells, and Frigate camera detections
 * (person, car, …). Columns are notification targets.
 *
 * The routing configuration (doorbells, cameras, targets, Frigate settings)
 * is edited in the card's configuration dialog (dashboard edit mode → edit
 * card). Saving there writes to the Dial Matrix integration over websocket;
 * the integration reloads and (re)creates the switch entities.
 *
 * Installation: add to Lovelace resources as a JavaScript module.
 * Usage:
 *   type: custom:dialmatrix-card
 *   title: "Call Routing Matrix"     # optional
 *   show_title: false                # optional; hide the header to save space
 *   event_types: [doorbell, person]  # optional filter; default: all
 *   group_rows: true                 # optional; group rows by event type
 *   editable: false                  # optional; also show a pencil on the card
 *   type_labels:                     # optional overrides for group headers
 *     person: "People"
 *   type_icons:                      # optional overrides for group icons
 *     car: "mdi:car-side"
 */

const DEFAULT_TITLE = 'Call Routing Matrix';

// Display metadata per event type. Unknown types fall back to a generic entry.
const TYPE_META = {
  doorbell: { label: 'Doorbells', icon: 'mdi:doorbell', order: 0 },
  person: { label: 'Person detected', icon: 'mdi:walk', order: 1 },
  car: { label: 'Car detected', icon: 'mdi:car', order: 2 },
};
const DEFAULT_TYPE_ICON = 'mdi:motion-sensor';

// Fallbacks if the integration doesn't report defaults (older backend)
const FALLBACK_DEFAULTS = {
  target: {
    notify_title: '$icon Doorbell',
    notify_message: 'Someone is at the $doorbell_name door',
    detect_title: '$icon $label_title detected',
    detect_message: 'A $label was detected at the $camera_name',
    notify_data: {},
    tts_message: 'Someone is at the $doorbell_name door',
    detect_tts_message: 'A $label was detected at the $camera_name',
    tts_announce: true,
  },
  camera: { labels: ['person', 'car'], zones: {} },
  frigate: {
    mqtt: true,
    mqtt_topic: 'frigate/events',
    image_url: '/api/frigate/notifications/$event_id/thumbnail.jpg',
  },
  labels: ['person', 'car', 'dog', 'cat', 'bird', 'bicycle', 'motorcycle', 'bus', 'truck'],
};

// Optional string fields that are dropped when left empty
const OPTIONAL_TEXT = new Set([
  'mqtt_topic',
  'frigate_camera',
  'notify_service',
  'tts_entity',
  'tts_media_player',
  'tts_volume',
]);

const escapeHtml = (str) =>
  String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const titleCase = (str) => {
  const s = String(str).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const errText = (err) => (err && (err.message || err.code)) || String(err);

// Shared form styling (HA theme variables)
const FORM_STYLES = `
  :host { display: block; color: var(--primary-text-color); }
  section { margin-bottom: 18px; }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--secondary-text-color);
  }
  h3 ha-icon { --mdc-icon-size: 16px; color: var(--primary-color, #03a9f4); }
  h3 .add { margin-left: auto; }
  .item {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 10px;
    margin-bottom: 8px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 8px;
    background: var(--secondary-background-color, rgba(127,127,127,0.06));
  }
  .fields {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    min-width: 0;
  }
  .f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .f.wide, details.wide { grid-column: 1 / -1; }
  .f > span { font-size: 0.72em; color: var(--secondary-text-color); }
  .f input[type="text"], .f textarea {
    font: inherit;
    font-size: 0.9em;
    padding: 6px 8px;
    border: 1px solid var(--divider-color, #bdbdbd);
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .f select {
    font: inherit;
    font-size: 0.9em;
    padding: 6px 8px;
    border: 1px solid var(--divider-color, #bdbdbd);
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .f select:focus { outline: none; border-color: var(--primary-color, #03a9f4); }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 4px 12px;
    padding: 6px 8px;
    border: 1px solid var(--divider-color, #bdbdbd);
    border-radius: 6px;
    max-height: 180px;
    overflow-y: auto;
    background: var(--card-background-color, #fff);
  }
  .choice { display: flex; align-items: center; gap: 6px; font-size: 0.9em; min-width: 0; }
  .test-row { flex-direction: row; align-items: center; gap: 10px; flex-wrap: wrap; }
  .test-row button { display: inline-flex; align-items: center; gap: 4px; }
  .test-row button ha-icon { --mdc-icon-size: 16px; }
  .test-status { margin: 0; }
  .test-status.ok { color: var(--success-color, #4caf50); }
  .test-status.error { color: var(--error-color, #db4437); }
  .choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .f textarea { resize: vertical; font-family: monospace; font-size: 0.82em; }
  .f input:focus, .f textarea:focus { outline: none; border-color: var(--primary-color, #03a9f4); }
  .f textarea.invalid { border-color: var(--error-color, #db4437); }
  .f.check { flex-direction: row; align-items: center; gap: 8px; }
  .f.check > span { font-size: 0.9em; color: var(--primary-text-color); }
  details { font-size: 0.9em; }
  summary { cursor: pointer; color: var(--primary-color, #03a9f4); font-size: 0.85em; margin: 2px 0 6px; }
  .hint { font-size: 0.78em; color: var(--secondary-text-color); margin: 4px 0; }
  code {
    background: var(--code-editor-background-color, rgba(127,127,127,0.15));
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.95em;
  }
  .error { color: var(--error-color, #db4437); font-size: 0.85em; margin: 8px 0; }
  .ok { color: var(--success-color, #4caf50); font-size: 0.85em; margin: 8px 0; }
  button.add, .actions button {
    font: inherit;
    font-size: 0.85em;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--primary-color, #03a9f4);
    background: transparent;
    color: var(--primary-color, #03a9f4);
    cursor: pointer;
  }
  .actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .actions .primary { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .actions .secondary { border-color: var(--divider-color, #bdbdbd); color: var(--secondary-text-color); }
  .actions button[disabled] { opacity: 0.6; cursor: default; }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--secondary-text-color);
    cursor: pointer;
    flex: none;
  }
  .icon-btn:hover { background: rgba(127,127,127,0.15); color: var(--primary-text-color); }
  .icon-btn.danger:hover { color: var(--error-color, #db4437); }
  .icon-btn ha-icon { --mdc-icon-size: 20px; }
`;

// =============================================================================
// Routing editor — the form for doorbells / cameras / targets / Frigate.
// Loads from and saves to the integration over websocket. Used by the card
// configuration dialog and (optionally) inline in the card.
// =============================================================================

class DialMatrixRoutingEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._draft = null;
    this._defaults = FALLBACK_DEFAULTS;
    this._error = '';
    this._notice = '';
    this._saving = false;
    this._loaded = false;
    this._jsonErrors = new Set();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded && hass) this.load();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (!this._loaded && this._hass) this.load();
    else this._render();
  }

  async load() {
    this._loaded = true; // prevent concurrent loads
    this._error = '';
    this._notice = '';
    if (!this._hass || typeof this._hass.callWS !== 'function') {
      this._error = 'This Home Assistant version does not support the editor.';
      this._render();
      return;
    }
    try {
      const res = await this._hass.callWS({ type: 'dialmatrix/config' });
      this._defaults = { ...FALLBACK_DEFAULTS, ...(res.defaults || {}) };
      this._draft = DialMatrixRoutingEditor.toDraft(res.config || {}, this._defaults);
      if (res.configured === false) {
        this._notice =
          'The Dial Matrix integration has no configuration yet. Fill in the form and save to create it.';
      }
    } catch (err) {
      this._draft = null;
      this._error =
        'Could not load the Dial Matrix configuration. Is the Dial Matrix integration installed and up to date? ' +
        `(${errText(err)})`;
    }
    this._jsonErrors = new Set();
    this._render();
  }

  async save() {
    if (!this._draft) return;
    if (this._jsonErrors.size > 0) {
      this._error = 'Fix the invalid JSON in "Extra push data" first.';
      this._render();
      return;
    }
    let config;
    try {
      config = DialMatrixRoutingEditor.fromDraft(this._draft);
    } catch (err) {
      this._error = err.message;
      this._render();
      return;
    }
    this._saving = true;
    this._error = '';
    this._notice = '';
    this._render();
    try {
      const res = await this._hass.callWS({ type: 'dialmatrix/config/save', config });
      this._saving = false;
      this._draft = DialMatrixRoutingEditor.toDraft(res.config || config, this._defaults);
      this._notice = 'Saved. The integration is reloading; the matrix updates in a moment.';
      this._render();
      this.dispatchEvent(new CustomEvent('dialmatrix-saved', { bubbles: true, composed: true }));
    } catch (err) {
      this._saving = false;
      this._error = `Save failed: ${errText(err)}`;
      this._render();
    }
  }

  /** Stored config → editor draft (strings everywhere the UI needs them). */
  static toDraft(config, defaults) {
    const camDefaults = defaults.camera || FALLBACK_DEFAULTS.camera;
    const tgtDefaults = defaults.target || FALLBACK_DEFAULTS.target;
    const frDefaults = defaults.frigate || FALLBACK_DEFAULTS.frigate;
    // Zones may be a list (applies to every label) or a mapping label → zones,
    // possibly with a '*' entry. The editor shows one field per label, so
    // expand list / '*' zones onto each label that has no explicit entry.
    const zonesToMap = (zones, labels) => {
      const map = Array.isArray(zones)
        ? { '*': zones }
        : zones && typeof zones === 'object'
          ? { ...zones }
          : {};
      const all = map['*'] || [];
      delete map['*'];
      for (const label of labels) {
        if (!map[label] && all.length) map[label] = [...all];
      }
      return map;
    };
    return {
      doorbells: (config.doorbells || []).map((d) => ({
        id: d.id || '',
        name: d.name || '',
        mqtt_topic: d.mqtt_topic || '',
      })),
      cameras: (config.cameras || []).map((c) => {
        const labels =
          Array.isArray(c.labels) && c.labels.length ? [...c.labels] : [...camDefaults.labels];
        return {
          id: c.id || '',
          name: c.name || '',
          frigate_camera: c.frigate_camera || '',
          labels,
          zones: zonesToMap(c.zones, labels),
        };
      }),
      targets: (config.targets || []).map((t) => ({
        ...tgtDefaults,
        ...t,
        notify_service: t.notify_service || '',
        tts_entity: t.tts_entity || '',
        tts_media_player: Array.isArray(t.tts_media_player)
          ? [...t.tts_media_player]
          : t.tts_media_player
            ? [t.tts_media_player]
            : [],
        tts_announce: t.tts_announce !== false,
        tts_volume: t.tts_volume == null ? '' : String(t.tts_volume),
        notify_data: t.notify_data && typeof t.notify_data === 'object' ? t.notify_data : {},
      })),
      frigate: { ...frDefaults, ...(config.frigate || {}) },
    };
  }

  /** Editor draft → config for the integration. Throws on user errors. */
  static fromDraft(draft) {
    const clean = (item) => {
      const out = {};
      for (const [k, v] of Object.entries(item)) {
        if (OPTIONAL_TEXT.has(k) && (v === '' || v == null)) continue;
        out[k] = typeof v === 'string' ? v.trim() : v;
      }
      return out;
    };
    const checkIds = (items, what) => {
      const seen = new Set();
      for (const it of items) {
        const id = String(it.id || '').trim();
        if (!id) throw new Error(`Every ${what} needs an ID.`);
        if (!/^[a-z0-9_]+$/.test(id))
          throw new Error(`${titleCase(what)} ID "${id}" may only contain a-z, 0-9 and _.`);
        if (seen.has(id)) throw new Error(`Duplicate ${what} ID "${id}".`);
        seen.add(id);
        if (!String(it.name || '').trim()) throw new Error(`${titleCase(what)} "${id}" needs a name.`);
      }
    };
    checkIds(draft.doorbells, 'doorbell');
    checkIds(draft.cameras, 'camera');
    checkIds(draft.targets, 'target');

    const cameras = draft.cameras.map((c) => {
      const labels = (c.labels || []).map((l) => String(l).trim()).filter(Boolean);
      if (labels.length === 0) throw new Error(`Camera "${c.id}" needs at least one label.`);
      const zones = {};
      for (const label of labels) {
        const z = (c.zones && c.zones[label]) || [];
        if (z.length) zones[label] = z;
      }
      return clean({ ...c, labels, zones });
    });

    const targets = draft.targets.map((t) => {
      const players = (Array.isArray(t.tts_media_player) ? t.tts_media_player : [t.tts_media_player])
        .map((p) => String(p || '').trim())
        .filter(Boolean);
      let volume = String(t.tts_volume == null ? '' : t.tts_volume).trim();
      if (volume !== '') {
        const n = Number(volume);
        if (!Number.isInteger(n) || n < 0 || n > 100)
          throw new Error(`Target "${t.id}": announcement volume must be a whole number from 0 to 100.`);
        volume = n;
      }
      return clean({
        ...t,
        tts_media_player: players.length ? players : '',
        tts_announce: t.tts_announce !== false,
        tts_volume: volume,
      });
    });

    return {
      doorbells: draft.doorbells.map(clean),
      cameras,
      targets,
      frigate: { ...draft.frigate, mqtt: !!draft.frigate.mqtt },
    };
  }

  /** Set a value inside the draft by dotted path, e.g. "targets.0.name". */
  _setPath(path, value) {
    const parts = path.split('.');
    let obj = this._draft;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] === undefined) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }

  _onInput(el) {
    const path = el.dataset.path;
    const kind = el.dataset.kind || 'text';
    if (kind === 'bool') {
      this._setPath(path, !!el.checked);
    } else if (kind === 'multi') {
      // one checkbox per option; the draft holds the list of checked values
      const parts = path.split('.');
      let list = this._draft;
      for (const part of parts) list = list[part];
      const current = Array.isArray(list) ? list : [];
      const next = el.checked
        ? [...new Set([...current, el.value])]
        : current.filter((v) => v !== el.value);
      this._setPath(path, next);
    } else if (kind === 'list') {
      this._setPath(
        path,
        el.value.split(',').map((s) => s.trim()).filter(Boolean),
      );
    } else if (kind === 'json') {
      const text = el.value.trim();
      if (text === '') {
        this._jsonErrors.delete(path);
        el.classList.remove('invalid');
        this._setPath(path, {});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        this._jsonErrors.delete(path);
        el.classList.remove('invalid');
        this._setPath(path, parsed);
      } catch {
        this._jsonErrors.add(path);
        el.classList.add('invalid');
      }
    } else {
      this._setPath(path, el.value);
    }
  }

  _onAction(el) {
    const action = el.dataset.action;
    const d = this._draft;
    if (action === 'add-doorbell') {
      d.doorbells.push({ id: '', name: '', mqtt_topic: '' });
    } else if (action === 'add-camera') {
      const c = this._defaults.camera || FALLBACK_DEFAULTS.camera;
      d.cameras.push({ id: '', name: '', frigate_camera: '', labels: [...c.labels], zones: {} });
    } else if (action === 'add-target') {
      const t = this._defaults.target || FALLBACK_DEFAULTS.target;
      d.targets.push({
        ...t,
        id: '',
        name: '',
        notify_service: '',
        tts_entity: '',
        tts_media_player: '',
        notify_data: {},
      });
    } else if (action === 'remove') {
      const [list, idx] = el.dataset.path.split('.');
      d[list].splice(Number(idx), 1);
    } else if (action === 'save') {
      this.save();
      return;
    } else if (action === 'test-tts') {
      this._testTts(Number(el.dataset.path.split('.')[1]), el);
      return;
    } else if (action === 'reload') {
      this._loaded = false;
      this.load();
      return;
    } else if (action === 'retry') {
      this._loaded = false;
      this.load();
      return;
    }
    this._render();
  }

  /**
   * Speak the target's doorbell TTS message on its speakers using the current
   * (unsaved) settings. Feedback is written next to the button without a
   * re-render, so the open <details> and typed values stay put.
   */
  async _testTts(index, button) {
    const t = this._draft && this._draft.targets[index];
    if (!t) return;
    const status = button && button.parentNode ? button.parentNode.querySelector('.test-status') : null;
    const say = (text, isError) => {
      if (status) {
        status.textContent = text;
        status.className = `test-status ${isError ? 'error' : 'ok'}`;
      }
      this._lastTest = { index, text, isError };
    };
    let target;
    try {
      target = DialMatrixRoutingEditor.fromDraft({ ...this._draft, doorbells: [], cameras: [], targets: [{ ...t, id: t.id || 'test', name: t.name || 'Test' }] }).targets[0];
    } catch (err) {
      say(err.message, true);
      return;
    }
    if (!target.tts_entity || !target.tts_media_player || !target.tts_media_player.length) {
      say('Pick a text-to-speech engine and at least one speaker first.', true);
      return;
    }
    if (button) button.disabled = true;
    say('Playing…', false);
    try {
      await this._hass.callWS({
        type: 'dialmatrix/tts/test',
        target: {
          tts_entity: target.tts_entity,
          tts_media_player: target.tts_media_player,
          tts_announce: target.tts_announce,
          ...(target.tts_volume !== undefined ? { tts_volume: target.tts_volume } : {}),
        },
        message: target.tts_message || 'This is a test announcement from Dial Matrix',
      });
      say('Sent to the speakers. Nothing to hear? Check the speaker is on and the volume.', false);
    } catch (err) {
      say(`Test failed: ${errText(err)}`, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  _render() {
    if (!this.shadowRoot) return;
    const esc = escapeHtml;

    if (!this._draft) {
      this.shadowRoot.innerHTML = `
        <style>${FORM_STYLES}</style>
        ${this._error ? `<p class="error">${esc(this._error)}</p><div class="actions"><button class="secondary" data-action="retry">Retry</button></div>` : `<p class="hint">Loading…</p>`}
      `;
      this._bind();
      return;
    }

    const d = this._draft;
    const text = (path, label, value, opts = {}) => `
      <label class="f ${opts.wide ? 'wide' : ''}">
        <span>${esc(label)}</span>
        <input type="text" data-path="${path}" data-kind="${opts.kind || 'text'}"
               ${opts.rerender ? 'data-rerender="true"' : ''}
               value="${esc(value)}" placeholder="${esc(opts.placeholder || '')}" spellcheck="false">
      </label>`;
    const removeBtn = (path, what) =>
      `<button class="icon-btn danger" data-action="remove" data-path="${path}" title="Remove ${what}" aria-label="Remove ${what}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>`;
    // Single-choice dropdown; a stored value that is not in the list is kept as an extra option
    const select = (path, label, value, options, opts = {}) => {
      const known = options.some((o) => o.value === value);
      const all = value && !known ? [{ value, label: `${value} (not found)` }, ...options] : options;
      return `
      <label class="f ${opts.wide ? 'wide' : ''}">
        <span>${esc(label)}</span>
        <select data-path="${path}" data-kind="select">
          <option value="" ${value ? '' : 'selected'}>${esc(opts.none || '— none —')}</option>
          ${all.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>`;
    };
    // Multi-choice checkbox list
    const multi = (path, label, values, options) => {
      const known = new Set(options.map((o) => o.value));
      const all = [...values.filter((v) => !known.has(v)).map((v) => ({ value: v, label: `${v} (not found)` })), ...options];
      const boxes = all.length
        ? all
            .map(
              (o) => `
          <label class="choice">
            <input type="checkbox" data-path="${path}" data-kind="multi" value="${esc(o.value)}" ${values.includes(o.value) ? 'checked' : ''}>
            <span>${esc(o.label)}</span>
          </label>`,
            )
            .join('')
        : `<span class="hint">No media players found.</span>`;
      return `
      <div class="f wide">
        <span>${esc(label)}</span>
        <div class="choices">${boxes}</div>
      </div>`;
    };
    const notifyOptions = this._notifyOptions();
    const ttsOptions = this._entityOptions('tts');
    const playerOptions = this._entityOptions('media_player');

    // Doorbells
    let doorbells = d.doorbells
      .map(
        (db, i) => `
        <div class="item">
          <div class="fields">
            ${text(`doorbells.${i}.id`, 'ID', db.id, { placeholder: 'front' })}
            ${text(`doorbells.${i}.name`, 'Name', db.name, { placeholder: 'Front Door' })}
            ${text(`doorbells.${i}.mqtt_topic`, 'MQTT topic (rings on message)', db.mqtt_topic, { placeholder: 'home/doorbell/front/frigate_event', wide: true })}
          </div>
          ${removeBtn(`doorbells.${i}`, 'doorbell')}
        </div>`,
      )
      .join('');
    if (!d.doorbells.length) doorbells = `<p class="hint">No doorbells.</p>`;

    // Cameras
    let cameras = d.cameras
      .map((c, i) => {
        const zoneFields = (c.labels || [])
          .map((label) =>
            text(`cameras.${i}.zones.${label}`, `Zones for ${label} (comma separated, optional)`, (c.zones[label] || []).join(', '), {
              kind: 'list',
              placeholder: `outside_driveway_${label}`,
            }),
          )
          .join('');
        return `
        <div class="item">
          <div class="fields">
            ${text(`cameras.${i}.id`, 'ID', c.id, { placeholder: 'driveway' })}
            ${text(`cameras.${i}.name`, 'Name', c.name, { placeholder: 'Driveway' })}
            ${text(`cameras.${i}.frigate_camera`, 'Frigate camera name (if different from ID)', c.frigate_camera, { placeholder: c.id || 'driveway' })}
            ${text(`cameras.${i}.labels`, 'Labels (comma separated)', (c.labels || []).join(', '), { kind: 'list', rerender: true, placeholder: 'person, car' })}
            ${zoneFields}
          </div>
          ${removeBtn(`cameras.${i}`, 'camera')}
        </div>`;
      })
      .join('');
    if (!d.cameras.length) cameras = `<p class="hint">No cameras.</p>`;

    // Targets
    let targets = d.targets
      .map(
        (t, i) => `
        <div class="item">
          <div class="fields">
            ${text(`targets.${i}.id`, 'ID', t.id, { placeholder: 'alice_phone' })}
            ${text(`targets.${i}.name`, 'Name', t.name, { placeholder: 'Alice' })}
            ${select(`targets.${i}.notify_service`, 'Notify service (phone)', t.notify_service, notifyOptions, { wide: true, none: '— no push notification —' })}
            <details class="wide">
              <summary>Messages, push extras and TTS</summary>
              <div class="fields">
                ${text(`targets.${i}.notify_title`, 'Doorbell push title', t.notify_title)}
                ${text(`targets.${i}.notify_message`, 'Doorbell push message', t.notify_message)}
                ${text(`targets.${i}.detect_title`, 'Detection push title', t.detect_title)}
                ${text(`targets.${i}.detect_message`, 'Detection push message', t.detect_message)}
                <label class="f wide">
                  <span>Extra push data (JSON, e.g. url, clickAction, ttl, priority)</span>
                  <textarea data-path="targets.${i}.notify_data" data-kind="json" rows="2" spellcheck="false">${esc(
                    Object.keys(t.notify_data || {}).length ? JSON.stringify(t.notify_data) : '',
                  )}</textarea>
                </label>
                ${select(`targets.${i}.tts_entity`, 'Text-to-speech engine', t.tts_entity, ttsOptions, { none: '— no speech —' })}
                ${multi(`targets.${i}.tts_media_player`, 'Speakers', t.tts_media_player || [], playerOptions)}
                ${text(`targets.${i}.tts_message`, 'Doorbell TTS message', t.tts_message)}
                ${text(`targets.${i}.detect_tts_message`, 'Detection TTS message', t.detect_tts_message)}
                ${text(`targets.${i}.tts_volume`, 'Announcement volume 0-100 (empty = current volume)', t.tts_volume, { placeholder: '40' })}
                <label class="f check">
                  <input type="checkbox" data-path="targets.${i}.tts_announce" data-kind="bool" ${t.tts_announce !== false ? 'checked' : ''}>
                  <span>Announce: duck the music, speak, resume (Sonos and similar)</span>
                </label>
                <div class="f wide test-row">
                  <button class="add" data-action="test-tts" data-path="targets.${i}" title="Speak the doorbell TTS message on the selected speakers with the settings above (unsaved changes included)">
                    <ha-icon icon="mdi:volume-high"></ha-icon> Test on speakers
                  </button>
                  <span class="test-status hint"></span>
                </div>
              </div>
            </details>
          </div>
          ${removeBtn(`targets.${i}`, 'target')}
        </div>`,
      )
      .join('');
    if (!d.targets.length) targets = `<p class="hint">No targets.</p>`;

    const f = d.frigate;
    const frigate = `
      <div class="item">
        <div class="fields">
          <label class="f check wide">
            <input type="checkbox" data-path="frigate.mqtt" data-kind="bool" ${f.mqtt ? 'checked' : ''}>
            <span>Listen to Frigate events over MQTT (no automations needed)</span>
          </label>
          ${text('frigate.mqtt_topic', 'Frigate MQTT topic', f.mqtt_topic, { placeholder: 'frigate/events' })}
          ${text('frigate.image_url', 'Push image URL ($event_id is substituted; empty = none)', f.image_url, {
            placeholder: '/api/frigate/notifications/$event_id/snapshot.jpg',
          })}
        </div>
      </div>`;

    this.shadowRoot.innerHTML = `
      <style>${FORM_STYLES}</style>
      <div class="editor">
        ${this._notice ? `<p class="ok">${esc(this._notice)}</p>` : ''}
        <section>
          <h3><ha-icon icon="mdi:doorbell"></ha-icon> Doorbells
            <button class="add" data-action="add-doorbell">+ Add</button></h3>
          ${doorbells}
        </section>
        <section>
          <h3><ha-icon icon="mdi:cctv"></ha-icon> Cameras (Frigate)
            <button class="add" data-action="add-camera">+ Add</button></h3>
          ${cameras}
        </section>
        <section>
          <h3><ha-icon icon="mdi:cellphone-message"></ha-icon> Notification targets
            <button class="add" data-action="add-target">+ Add</button></h3>
          ${targets}
          <p class="hint">Placeholders: <code>$icon</code>, <code>$doorbell_name</code>, <code>$camera_name</code>, <code>$label</code>, <code>$label_title</code>, <code>$sub_label</code>, <code>$zones</code>.</p>
        </section>
        <section>
          <h3><ha-icon icon="mdi:cog"></ha-icon> Frigate settings</h3>
          ${frigate}
        </section>
        ${this._error ? `<p class="error">${esc(this._error)}</p>` : ''}
        <div class="actions">
          <span class="hint">Routing is saved to the integration directly, independent of the dashboard.</span>
          <button class="secondary" data-action="reload" ${this._saving ? 'disabled' : ''}>Discard changes</button>
          <button class="primary" data-action="save" ${this._saving ? 'disabled' : ''}>${this._saving ? 'Saving…' : 'Save routing'}</button>
        </div>
      </div>`;
    this._bind();
  }

  _bind() {
    this.shadowRoot.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._onAction(el);
      });
    });
    this.shadowRoot.querySelectorAll('[data-path]:not([data-action])').forEach((el) => {
      const kind = el.dataset.kind;
      const evt = kind === 'bool' || kind === 'multi' || kind === 'select' ? 'change' : 'input';
      el.addEventListener(evt, () => this._onInput(el));
      if (el.dataset.rerender === 'true') {
        el.addEventListener('change', () => this._render());
      }
    });
  }

  // -- entity / service choices from the live hass object --------------------

  _entityOptions(domain) {
    const states = (this._hass && this._hass.states) || {};
    return Object.keys(states)
      .filter((id) => id.startsWith(`${domain}.`))
      .map((id) => ({ value: id, label: (states[id].attributes || {}).friendly_name || id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  _notifyOptions() {
    const notify = (this._hass && this._hass.services && this._hass.services.notify) || {};
    return Object.keys(notify)
      .filter((name) => name !== 'notify' && name !== 'send_message' && name !== 'persistent_notification')
      .sort()
      .map((name) => ({ value: `notify.${name}`, label: `notify.${name}` }));
  }
}

// =============================================================================
// Card configuration editor — shown in the dashboard's "edit card" dialog.
// Card display options on top, the routing editor below.
// =============================================================================

class DialMatrixCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._routing = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._routing) this._routing.hass = hass;
  }

  _fireChange() {
    this.dispatchEvent(
      new CustomEvent('config-changed', {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _onOption(el) {
    const key = el.dataset.option;
    const kind = el.dataset.kind || 'text';
    const cfg = { ...this._config };
    if (kind === 'bool') {
      cfg[key] = !!el.checked;
      // Drop the key when it equals the default
      if (
        (key === 'group_rows' && cfg[key] === true) ||
        (key === 'show_title' && cfg[key] === true) ||
        (key === 'editable' && cfg[key] === false)
      )
        delete cfg[key];
    } else if (kind === 'list') {
      const list = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) cfg[key] = list;
      else delete cfg[key];
    } else {
      const v = el.value.trim();
      if (v) cfg[key] = v;
      else delete cfg[key];
    }
    this._config = cfg;
    this._fireChange();
  }

  _render() {
    if (!this.shadowRoot) return;
    const c = this._config;
    const esc = escapeHtml;
    this.shadowRoot.innerHTML = `
      <style>
        ${FORM_STYLES}
        .card-options { margin-bottom: 18px; }
        .routing-title { margin-top: 4px; }
      </style>
      <section class="card-options">
        <h3><ha-icon icon="mdi:view-grid-outline"></ha-icon> Card</h3>
        <div class="item">
          <div class="fields">
            <label class="f">
              <span>Title</span>
              <input type="text" data-option="title" value="${esc(typeof c.title === 'string' ? c.title : '')}" placeholder="${esc(DEFAULT_TITLE)}">
            </label>
            <label class="f check">
              <input type="checkbox" data-option="show_title" data-kind="bool" ${c.show_title !== false ? 'checked' : ''}>
              <span>Show title</span>
            </label>
            <label class="f">
              <span>Show only event types (comma separated, empty = all)</span>
              <input type="text" data-option="event_types" data-kind="list" value="${esc((c.event_types || []).join(', '))}" placeholder="doorbell, person, car">
            </label>
            <label class="f check">
              <input type="checkbox" data-option="group_rows" data-kind="bool" ${c.group_rows !== false ? 'checked' : ''}>
              <span>Group rows by event type</span>
            </label>
            <label class="f check">
              <input type="checkbox" data-option="editable" data-kind="bool" ${c.editable === true ? 'checked' : ''}>
              <span>Show a pencil button on the card for quick edits</span>
            </label>
          </div>
        </div>
      </section>
      <section>
        <h3 class="routing-title"><ha-icon icon="mdi:swap-horizontal"></ha-icon> Routing (doorbells, cameras, targets)</h3>
        <dialmatrix-routing-editor></dialmatrix-routing-editor>
      </section>
    `;
    this.shadowRoot.querySelectorAll('[data-option]').forEach((el) => {
      const evt = el.dataset.kind === 'bool' ? 'change' : 'input';
      el.addEventListener(evt, () => this._onOption(el));
    });
    this._routing = this.shadowRoot.querySelector('dialmatrix-routing-editor');
    if (this._routing && this._hass) this._routing.hass = this._hass;
  }
}

// =============================================================================
// The card
// =============================================================================

class DialMatrixCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._renderedStateHash = null;
    this._editing = false;
    this._routing = null;
  }

  static getConfigElement() {
    return document.createElement('dialmatrix-card-editor');
  }

  /**
   * Called by Lovelace when the card config is set/updated.
   */
  setConfig(config) {
    if (config.event_types !== undefined && !Array.isArray(config.event_types)) {
      throw new Error('dialmatrix-card: `event_types` must be a list');
    }
    this._config = {
      group_rows: true,
      editable: false,
      type_labels: {},
      type_icons: {},
      ...config,
    };
    this._renderedStateHash = null;
    this._render();
  }

  /**
   * Called by Lovelace whenever any entity state changes.
   * Only re-renders when matrix switches actually changed, and never while
   * the inline editor is open (that would wipe what the user is typing).
   */
  set hass(hass) {
    this._hass = hass;
    if (this._editing) {
      if (this._routing) this._routing.hass = hass;
      return;
    }

    // Build a lightweight hash of only the matrix switch states
    const hash = this._getMatrixSwitches()
      .map((s) => `${s.entity_id}:${s.state}`)
      .sort()
      .join('|');

    if (hash !== this._renderedStateHash) {
      this._renderedStateHash = hash;
      this._render();
    }
  }

  // ---------------------------------------------------------------------------
  // Matrix helpers
  // ---------------------------------------------------------------------------

  static _isMatrixSwitch(s) {
    const a = s.attributes;
    return (
      a.target_id !== undefined &&
      (a.source_id !== undefined || a.doorbell_id !== undefined)
    );
  }

  /**
   * Normalise a switch state object. Supports both the current attribute set
   * (source_id / event_type) and the legacy doorbell-only set (doorbell_id).
   */
  static _normalise(s) {
    const a = s.attributes;
    const eventType = a.event_type || 'doorbell';
    return {
      entityId: s.entity_id,
      on: s.state === 'on',
      eventType,
      sourceId: a.source_id !== undefined ? a.source_id : a.doorbell_id,
      sourceName:
        a.source_name !== undefined ? a.source_name : a.doorbell_name || a.doorbell_id,
      targetId: a.target_id,
      targetName: a.target_name !== undefined ? a.target_name : a.target_id,
      order: Array.isArray(a.sort_order) ? a.sort_order : null,
    };
  }

  _getMatrixSwitches() {
    if (!this._hass) return [];
    let switches = Object.values(this._hass.states).filter(
      DialMatrixCard._isMatrixSwitch,
    );
    const filter = this._config.event_types;
    if (Array.isArray(filter) && filter.length > 0) {
      const allowed = new Set(filter.map(String));
      switches = switches.filter((s) =>
        allowed.has(String(s.attributes.event_type || 'doorbell')),
      );
    }
    return switches;
  }

  _typeMeta(type) {
    const base = TYPE_META[type] || {
      label: `${titleCase(type)} detected`,
      icon: DEFAULT_TYPE_ICON,
      order: 100,
    };
    return {
      label: this._config.type_labels[type] || base.label,
      icon: this._config.type_icons[type] || base.icon,
      order: base.order,
    };
  }

  static _compareOrder(a, b) {
    // Prefer explicit sort_order from the integration; otherwise keep order.
    if (a.order && b.order) {
      const n = Math.max(a.order.length, b.order.length);
      for (let i = 0; i < n; i++) {
        const d = (a.order[i] ?? 0) - (b.order[i] ?? 0);
        if (d !== 0) return d;
      }
    }
    return 0;
  }

  /**
   * Build the matrix model:
   *   groups:  [{ type, label, icon, rows: [{ key, id, name }] }]
   *   targets: [{ id, name }]
   *   cells:   Map<`${rowKey}|${targetId}`, { entityId, on }>
   */
  _buildMatrix(switches) {
    const items = switches.map(DialMatrixCard._normalise);
    items.sort(DialMatrixCard._compareOrder);

    const groupMap = new Map();
    const targetMap = new Map();
    const cells = new Map();

    for (const it of items) {
      const rowKey = `${it.eventType}::${it.sourceId}`;
      if (!groupMap.has(it.eventType)) {
        groupMap.set(it.eventType, {
          type: it.eventType,
          ...this._typeMeta(it.eventType),
          rows: new Map(),
        });
      }
      const group = groupMap.get(it.eventType);
      if (!group.rows.has(rowKey)) {
        group.rows.set(rowKey, { key: rowKey, id: it.sourceId, name: it.sourceName });
      }
      if (!targetMap.has(it.targetId)) targetMap.set(it.targetId, it.targetName);
      cells.set(`${rowKey}|${it.targetId}`, { entityId: it.entityId, on: it.on });
    }

    const groups = [...groupMap.values()]
      .sort((a, b) => a.order - b.order)
      .map((g) => ({ ...g, rows: [...g.rows.values()] }));

    return {
      groups,
      targets: [...targetMap.entries()].map(([id, name]) => ({ id, name })),
      cells,
    };
  }

  _toggle(entityId) {
    this._hass.callService('homeassistant', 'toggle', {
      entity_id: entityId,
    });
  }

  _setEditing(on) {
    this._editing = on;
    this._renderedStateHash = null;
    this._render();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    if (!this.shadowRoot) return;

    const title = this._config.title || DEFAULT_TITLE;
    const showTitle = this._config.show_title !== false && this._config.title !== false;
    const switches = this._getMatrixSwitches();
    const { groups, targets, cells } = this._buildMatrix(switches);
    const groupRows = this._config.group_rows !== false;
    const rowCount = groups.reduce((n, g) => n + g.rows.length, 0);

    const colTemplate =
      targets.length > 0
        ? `auto ${Array(targets.length).fill('minmax(44px, 1fr)').join(' ')}`
        : 'auto';

    // Header row
    let html = `<div class="cell corner"></div>`;
    for (const t of targets) {
      html += `<div class="cell th"><span class="th-text">${escapeHtml(t.name)}</span></div>`;
    }

    // Data rows, grouped by event type
    for (const g of groups) {
      if (groupRows) {
        html += `
          <div class="cell group">
            <ha-icon class="group-icon" icon="${escapeHtml(g.icon)}"></ha-icon>
            <span class="group-text">${escapeHtml(g.label)}</span>
          </div>`;
      }
      for (const row of g.rows) {
        const rowLabel =
          groupRows || g.type === 'doorbell'
            ? escapeHtml(row.name)
            : `<ha-icon class="row-icon" icon="${escapeHtml(g.icon)}"></ha-icon>${escapeHtml(row.name)}`;
        const rowTitle =
          g.type === 'doorbell' ? row.name : `${row.name} · ${titleCase(g.type)}`;
        html += `<div class="cell rh" title="${escapeHtml(rowTitle)}">${rowLabel}</div>`;

        for (const t of targets) {
          const cell = cells.get(`${row.key}|${t.id}`);
          if (cell) {
            const { on, entityId } = cell;
            html += `
              <div class="cell">
                <button
                  class="btn ${on ? 'on' : 'off'}"
                  data-entity="${escapeHtml(entityId)}"
                  title="${escapeHtml(rowTitle)} → ${escapeHtml(t.name)}: ${on ? 'enabled' : 'disabled'}"
                  aria-pressed="${on}"
                  aria-label="${escapeHtml(rowTitle)} to ${escapeHtml(t.name)}"
                >${on ? '✓' : '✗'}</button>
              </div>`;
          } else {
            html += `<div class="cell"><span class="missing">–</span></div>`;
          }
        }
      }
    }

    const emptyState =
      rowCount === 0 && !this._editing
        ? `<p class="empty">No routing rows yet. Edit this card (dashboard edit mode) to add doorbells, cameras and targets.</p>`
        : '';

    const editButton = this._config.editable
      ? `<button class="icon-btn" data-action="${this._editing ? 'close' : 'open'}" title="${this._editing ? 'Close editor' : 'Edit routing'}" aria-label="${this._editing ? 'Close editor' : 'Edit routing'}">
           <ha-icon icon="${this._editing ? 'mdi:close' : 'mdi:pencil'}"></ha-icon>
         </button>`
      : '';

    // Header: title and/or pencil. Omitted entirely when neither is shown,
    // and shrunk to just the pencil when the title is hidden.
    const header =
      showTitle || editButton
        ? `<div class="header ${showTitle ? '' : 'compact'}">
             ${showTitle ? `<h2>${escapeHtml(title)}</h2>` : ''}
             ${editButton}
           </div>`
        : '';

    this.shadowRoot.innerHTML = `
      <style>${DialMatrixCard._styles(colTemplate)}</style>
      <ha-card>
        <div class="card-content ${showTitle ? '' : 'no-title'}">
          ${header}
          ${emptyState}
          ${rowCount > 0 ? `<div class="grid">${html}</div>` : ''}
          ${this._editing ? `<div class="inline-editor"><dialmatrix-routing-editor></dialmatrix-routing-editor></div>` : ''}
        </div>
      </ha-card>
    `;

    // Attach handlers after DOM is set
    this.shadowRoot.querySelectorAll('.btn[data-entity]').forEach((btn) => {
      btn.addEventListener('click', () => this._toggle(btn.dataset.entity));
    });
    this.shadowRoot.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._setEditing(el.dataset.action === 'open');
      });
    });
    this._routing = this.shadowRoot.querySelector('dialmatrix-routing-editor');
    if (this._routing && this._hass) this._routing.hass = this._hass;
  }

  static _styles(colTemplate) {
    return `
        :host { display: block; }

        .card-content { padding: 16px; }
        .card-content.no-title { padding-top: 8px; }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin: 0 0 14px;
        }
        .header.compact { justify-content: flex-end; margin: 0; }
        h2 {
          margin: 0;
          font-size: 1.05em;
          font-weight: 500;
          color: var(--primary-text-color);
        }

        .grid {
          display: grid;
          grid-template-columns: ${colTemplate};
          gap: 5px;
          overflow-x: auto;
        }

        .cell {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 40px;
        }

        /* Column headers — rotated target names */
        .cell.th {
          align-items: flex-end;
          padding-bottom: 4px;
          min-height: 72px;
        }
        .th-text {
          display: block;
          writing-mode: vertical-rl;
          text-orientation: mixed;
          transform: rotate(180deg);
          font-size: 0.72em;
          font-weight: 600;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }

        /* Group headers — one per event type, spanning all columns */
        .cell.group {
          grid-column: 1 / -1;
          justify-content: flex-start;
          gap: 6px;
          min-height: 28px;
          margin-top: 6px;
          padding-bottom: 2px;
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
          font-size: 0.72em;
          font-weight: 600;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .group-icon {
          --mdc-icon-size: 16px;
          color: var(--primary-color, #03a9f4);
        }

        /* Row headers — source names */
        .cell.rh {
          justify-content: flex-start;
          gap: 6px;
          padding-right: 10px;
          font-size: 0.85em;
          font-weight: 500;
          color: var(--primary-text-color);
          white-space: nowrap;
        }
        .row-icon {
          --mdc-icon-size: 16px;
          color: var(--secondary-text-color);
        }

        .cell.corner { min-height: 72px; }

        /* Toggle buttons */
        .btn {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 2px solid transparent;
          cursor: pointer;
          font-size: 1em;
          font-weight: 700;
          line-height: 1;
          transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
          outline: none;
        }
        .btn:focus-visible { box-shadow: 0 0 0 3px var(--primary-color, #03a9f4); }
        .btn.on {
          background-color: var(--success-color, #4caf50);
          border-color: var(--success-color, #4caf50);
          color: #fff;
        }
        .btn.off {
          background-color: transparent;
          border-color: var(--divider-color, #bdbdbd);
          color: var(--secondary-text-color, #9e9e9e);
        }
        .btn:hover { opacity: 0.75; }

        .missing { color: var(--divider-color, #bdbdbd); font-size: 1.2em; }

        .empty {
          color: var(--secondary-text-color);
          font-style: italic;
          font-size: 0.9em;
          text-align: center;
          margin: 24px 0;
        }

        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--secondary-text-color);
          cursor: pointer;
          flex: none;
        }
        .icon-btn:hover { background: rgba(127,127,127,0.15); color: var(--primary-text-color); }
        .icon-btn ha-icon { --mdc-icon-size: 20px; }

        .inline-editor {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
    `;
  }

  // Used by Lovelace to size the card in the grid
  getCardSize() {
    const { groups } = this._buildMatrix(this._getMatrixSwitches());
    const rows = groups.reduce((n, g) => n + g.rows.length, 0);
    const headers = this._config.group_rows !== false ? groups.length : 0;
    return Math.max(3, rows + headers + 2) + (this._editing ? 10 : 0);
  }

  // Stub config for the card picker UI
  static getStubConfig() {
    return { title: DEFAULT_TITLE };
  }
}

customElements.define('dialmatrix-routing-editor', DialMatrixRoutingEditor);
customElements.define('dialmatrix-card-editor', DialMatrixCardEditor);
customElements.define('dialmatrix-card', DialMatrixCard);

// Register with the Lovelace custom card registry
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'dialmatrix-card',
  name: 'Dial Matrix Card',
  description:
    'Visual event-routing matrix: choose which targets are notified for each doorbell ring and Frigate person / car detection. Routing is configured in the card editor.',
  preview: true,
});
