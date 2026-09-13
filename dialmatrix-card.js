/**
 * Dial Matrix Card — custom Lovelace card for Home Assistant
 * Renders a visual event-routing matrix and toggles switch entities.
 *
 * Rows are event sources: doorbells, and Frigate camera detections
 * (person, car, …). Columns are notification targets.
 *
 * The pencil button opens an inline editor for doorbells, cameras, targets
 * and Frigate settings. Saving stores the configuration in the Dial Matrix
 * integration, which reloads and (re)creates the switch entities.
 *
 * Installation: add to Lovelace resources as a JavaScript module.
 * Usage:
 *   type: custom:dialmatrix-card
 *   title: "Call Routing Matrix"     # optional
 *   event_types: [doorbell, person]  # optional filter; default: all
 *   group_rows: true                 # optional; group rows by event type
 *   editable: true                   # optional; show the edit button
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
]);

class DialMatrixCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._renderedStateHash = null;

    // Editor state
    this._editing = false;
    this._draft = null;
    this._defaults = FALLBACK_DEFAULTS;
    this._editorError = '';
    this._saving = false;
    this._jsonErrors = new Set();
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
      editable: true,
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
   * the editor is open (that would wipe what the user is typing).
   */
  set hass(hass) {
    this._hass = hass;
    if (this._editing) return;

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
      label: `${DialMatrixCard._titleCase(type)} detected`,
      icon: DEFAULT_TYPE_ICON,
      order: 100,
    };
    return {
      label: this._config.type_labels[type] || base.label,
      icon: this._config.type_icons[type] || base.icon,
      order: base.order,
    };
  }

  static _titleCase(str) {
    const s = String(str).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
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

  // ---------------------------------------------------------------------------
  // Editor state
  // ---------------------------------------------------------------------------

  async _openEditor() {
    if (!this._hass || typeof this._hass.callWS !== 'function') {
      this._editorError = 'This Home Assistant version does not support the editor.';
      this._render();
      return;
    }
    this._editorError = '';
    try {
      const res = await this._hass.callWS({ type: 'dialmatrix/config' });
      this._defaults = { ...FALLBACK_DEFAULTS, ...(res.defaults || {}) };
      this._draft = DialMatrixCard._toDraft(res.config || {}, this._defaults);
    } catch (err) {
      this._editorError =
        'Could not load the Dial Matrix configuration. Is the Dial Matrix integration installed and up to date? ' +
        `(${(err && (err.message || err.code)) || err})`;
      this._render();
      return;
    }
    this._editing = true;
    this._jsonErrors = new Set();
    this._render();
  }

  _closeEditor() {
    this._editing = false;
    this._draft = null;
    this._editorError = '';
    this._jsonErrors = new Set();
    this._renderedStateHash = null;
    this._render();
  }

  async _save() {
    if (this._jsonErrors.size > 0) {
      this._editorError = 'Fix the invalid JSON in "Extra push data" first.';
      this._render();
      return;
    }
    let config;
    try {
      config = DialMatrixCard._fromDraft(this._draft);
    } catch (err) {
      this._editorError = err.message;
      this._render();
      return;
    }
    this._saving = true;
    this._editorError = '';
    this._render();
    try {
      await this._hass.callWS({ type: 'dialmatrix/config/save', config });
      this._saving = false;
      this._closeEditor();
    } catch (err) {
      this._saving = false;
      this._editorError = `Save failed: ${(err && (err.message || err.code)) || err}`;
      this._render();
    }
  }

  /** Stored config → editor draft (strings everywhere the UI needs them). */
  static _toDraft(config, defaults) {
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
        tts_media_player: t.tts_media_player || '',
        notify_data: t.notify_data && typeof t.notify_data === 'object' ? t.notify_data : {},
      })),
      frigate: { ...frDefaults, ...(config.frigate || {}) },
    };
  }

  /** Editor draft → config for the integration. Throws on user errors. */
  static _fromDraft(draft) {
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
          throw new Error(`${DialMatrixCard._titleCase(what)} ID "${id}" may only contain a-z, 0-9 and _.`);
        if (seen.has(id)) throw new Error(`Duplicate ${what} ID "${id}".`);
        seen.add(id);
        if (!String(it.name || '').trim()) throw new Error(`${DialMatrixCard._titleCase(what)} "${id}" needs a name.`);
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

    return {
      doorbells: draft.doorbells.map(clean),
      cameras,
      targets: draft.targets.map(clean),
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

  _onEditorInput(el) {
    const path = el.dataset.path;
    const kind = el.dataset.kind || 'text';
    if (kind === 'bool') {
      this._setPath(path, !!el.checked);
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

  _onEditorAction(el) {
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
      this._save();
      return;
    } else if (action === 'cancel') {
      this._closeEditor();
      return;
    } else if (action === 'refresh-zones') {
      // labels changed: re-render so the zone fields follow
    }
    this._render();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _render() {
    if (!this.shadowRoot) return;

    const title = this._config.title || DEFAULT_TITLE;
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
      html += `<div class="cell th"><span class="th-text">${this._escape(t.name)}</span></div>`;
    }

    // Data rows, grouped by event type
    for (const g of groups) {
      if (groupRows) {
        html += `
          <div class="cell group">
            <ha-icon class="group-icon" icon="${this._escape(g.icon)}"></ha-icon>
            <span class="group-text">${this._escape(g.label)}</span>
          </div>`;
      }
      for (const row of g.rows) {
        const rowLabel =
          groupRows || g.type === 'doorbell'
            ? this._escape(row.name)
            : `<ha-icon class="row-icon" icon="${this._escape(g.icon)}"></ha-icon>${this._escape(row.name)}`;
        const rowTitle =
          g.type === 'doorbell'
            ? row.name
            : `${row.name} · ${DialMatrixCard._titleCase(g.type)}`;
        html += `<div class="cell rh" title="${this._escape(rowTitle)}">${rowLabel}</div>`;

        for (const t of targets) {
          const cell = cells.get(`${row.key}|${t.id}`);
          if (cell) {
            const { on, entityId } = cell;
            html += `
              <div class="cell">
                <button
                  class="btn ${on ? 'on' : 'off'}"
                  data-entity="${this._escape(entityId)}"
                  title="${this._escape(rowTitle)} → ${this._escape(t.name)}: ${on ? 'enabled' : 'disabled'}"
                  aria-pressed="${on}"
                  aria-label="${this._escape(rowTitle)} to ${this._escape(t.name)}"
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
        ? `<p class="empty">No routing rows yet. ${
            this._config.editable !== false
              ? 'Use the pencil button to add doorbells, cameras and targets.'
              : 'Add doorbells, cameras and targets under <code>Settings → Devices &amp; services → Dial Matrix → Configure</code>.'
          }</p>`
        : '';

    const editButton =
      this._config.editable !== false
        ? `<button class="icon-btn" data-action="${this._editing ? 'cancel' : 'open'}" title="${this._editing ? 'Close editor' : 'Edit routing configuration'}" aria-label="${this._editing ? 'Close editor' : 'Edit routing configuration'}">
             <ha-icon icon="${this._editing ? 'mdi:close' : 'mdi:pencil'}"></ha-icon>
           </button>`
        : '';

    const errorBanner =
      this._editorError && !this._editing
        ? `<p class="error">${this._escape(this._editorError)}</p>`
        : '';

    this.shadowRoot.innerHTML = `
      <style>${DialMatrixCard._styles(colTemplate)}</style>
      <ha-card>
        <div class="card-content">
          <div class="header">
            <h2>${this._escape(title)}</h2>
            ${editButton}
          </div>
          ${errorBanner}
          ${emptyState}
          ${rowCount > 0 ? `<div class="grid">${html}</div>` : ''}
          ${this._editing ? this._renderEditor() : ''}
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
        if (el.dataset.action === 'open') this._openEditor();
        else this._onEditorAction(el);
      });
    });
    this.shadowRoot.querySelectorAll('[data-path]:not([data-action])').forEach((el) => {
      const evt = el.dataset.kind === 'bool' ? 'change' : 'input';
      el.addEventListener(evt, () => this._onEditorInput(el));
      if (el.dataset.kind === 'list' && el.dataset.rerender === 'true') {
        el.addEventListener('change', () => this._render());
      }
    });
  }

  _renderEditor() {
    const d = this._draft;
    const esc = (v) => this._escape(v == null ? '' : v);
    const text = (path, label, value, opts = {}) => `
      <label class="f ${opts.wide ? 'wide' : ''}">
        <span>${esc(label)}</span>
        <input type="text" data-path="${path}" data-kind="${opts.kind || 'text'}"
               ${opts.rerender ? 'data-rerender="true"' : ''}
               value="${esc(value)}" placeholder="${esc(opts.placeholder || '')}" spellcheck="false">
      </label>`;
    const removeBtn = (path, what) =>
      `<button class="icon-btn danger" data-action="remove" data-path="${path}" title="Remove ${what}" aria-label="Remove ${what}"><ha-icon icon="mdi:delete-outline"></ha-icon></button>`;

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
            ${text(`targets.${i}.notify_service`, 'Notify service', t.notify_service, { placeholder: 'notify.mobile_app_alice_iphone', wide: true })}
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
                ${text(`targets.${i}.tts_entity`, 'TTS entity', t.tts_entity, { placeholder: 'tts.google_en_com' })}
                ${text(`targets.${i}.tts_media_player`, 'TTS media player', t.tts_media_player, { placeholder: 'media_player.living_room' })}
                ${text(`targets.${i}.tts_message`, 'Doorbell TTS message', t.tts_message)}
                ${text(`targets.${i}.detect_tts_message`, 'Detection TTS message', t.detect_tts_message)}
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

    return `
      <div class="editor">
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
        ${this._editorError ? `<p class="error">${esc(this._editorError)}</p>` : ''}
        <div class="actions">
          <button class="secondary" data-action="cancel" ${this._saving ? 'disabled' : ''}>Cancel</button>
          <button class="primary" data-action="save" ${this._saving ? 'disabled' : ''}>${this._saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>`;
  }

  static _styles(colTemplate) {
    return `
        :host { display: block; }

        .card-content { padding: 16px; }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin: 0 0 14px;
        }
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
        code {
          background: var(--code-editor-background-color, rgba(127,127,127,0.15));
          padding: 1px 4px;
          border-radius: 3px;
          font-size: 0.95em;
        }
        .error {
          color: var(--error-color, #db4437);
          font-size: 0.85em;
          margin: 8px 0;
        }

        /* Icon buttons (edit / close / remove) */
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

        /* Editor */
        .editor {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid var(--divider-color, #e0e0e0);
        }
        .editor section { margin-bottom: 18px; }
        .editor h3 {
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
        .editor h3 ha-icon { --mdc-icon-size: 16px; color: var(--primary-color, #03a9f4); }
        .editor h3 .add { margin-left: auto; }
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
        .f > span {
          font-size: 0.72em;
          color: var(--secondary-text-color);
        }
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
        .f textarea { resize: vertical; font-family: monospace; font-size: 0.82em; }
        .f input:focus, .f textarea:focus {
          outline: none;
          border-color: var(--primary-color, #03a9f4);
        }
        .f textarea.invalid { border-color: var(--error-color, #db4437); }
        .f.check { flex-direction: row; align-items: center; gap: 8px; }
        .f.check > span { font-size: 0.9em; color: var(--primary-text-color); }
        details { font-size: 0.9em; }
        summary { cursor: pointer; color: var(--primary-color, #03a9f4); font-size: 0.85em; margin: 2px 0 6px; }
        .hint { font-size: 0.78em; color: var(--secondary-text-color); margin: 4px 0; }
        .hint code { font-size: 0.95em; }

        .editor button.add, .actions button {
          font: inherit;
          font-size: 0.85em;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--primary-color, #03a9f4);
          background: transparent;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
        }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
        .actions .primary { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        .actions .secondary { border-color: var(--divider-color, #bdbdbd); color: var(--secondary-text-color); }
        .actions button[disabled] { opacity: 0.6; cursor: default; }
    `;
  }

  _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

customElements.define('dialmatrix-card', DialMatrixCard);

// Register with the Lovelace custom card registry
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'dialmatrix-card',
  name: 'Dial Matrix Card',
  description:
    'Visual event-routing matrix: choose which targets are notified for each doorbell ring and Frigate person / car detection. Includes an inline editor for the routing configuration.',
  preview: true,
});
