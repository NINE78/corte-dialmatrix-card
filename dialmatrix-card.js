/**
 * Dial Matrix Card — custom Lovelace card for Home Assistant
 * Renders a visual event-routing matrix and toggles switch entities.
 *
 * Rows are event sources: doorbells, and Frigate camera detections
 * (person, car, …). Columns are notification targets.
 *
 * Installation: add to Lovelace resources as a JavaScript module.
 * Usage:
 *   type: custom:dialmatrix-card
 *   title: "Call Routing Matrix"     # optional
 *   event_types: [doorbell, person]  # optional filter; default: all
 *   group_rows: true                 # optional; group rows by event type
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

class DialMatrixCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._renderedStateHash = null;
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
      type_labels: {},
      type_icons: {},
      ...config,
    };
    this._renderedStateHash = null;
    this._render();
  }

  /**
   * Called by Lovelace whenever any entity state changes.
   * Only re-renders when matrix switches actually changed.
   */
  set hass(hass) {
    this._hass = hass;

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
  // Helpers
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
    // Prefer explicit sort_order from the integration; fall back to type order.
    if (a.order && b.order) {
      const n = Math.max(a.order.length, b.order.length);
      for (let i = 0; i < n; i++) {
        const d = (a.order[i] ?? 0) - (b.order[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
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
      rowCount === 0
        ? `<p class="empty">No Dial Matrix switches found. Add doorbells, cameras and targets under <code>Settings → Devices &amp; services → Dial Matrix → Configure</code>.</p>`
        : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        .card-content {
          padding: 16px;
        }

        h2 {
          margin: 0 0 14px;
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

        /* Corner spacer */
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
        .btn:focus-visible {
          box-shadow: 0 0 0 3px var(--primary-color, #03a9f4);
        }
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

        .missing {
          color: var(--divider-color, #bdbdbd);
          font-size: 1.2em;
        }

        .empty {
          color: var(--secondary-text-color);
          font-style: italic;
          font-size: 0.9em;
          text-align: center;
          margin: 24px 0;
        }
        .empty code {
          background: var(--code-editor-background-color, #f5f5f5);
          padding: 1px 4px;
          border-radius: 3px;
          font-size: 0.95em;
        }
      </style>

      <ha-card>
        <div class="card-content">
          <h2>${this._escape(title)}</h2>
          ${emptyState}
          ${rowCount > 0 ? `<div class="grid">${html}</div>` : ''}
        </div>
      </ha-card>
    `;

    // Attach click handlers after DOM is set
    this.shadowRoot.querySelectorAll('.btn[data-entity]').forEach((btn) => {
      btn.addEventListener('click', () => this._toggle(btn.dataset.entity));
    });
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
    return Math.max(3, rows + headers + 2);
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
    'Visual event-routing matrix: choose which targets are notified for each doorbell ring and Frigate person / car detection.',
  preview: true,
});
