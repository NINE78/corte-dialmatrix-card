/**
 * Dial Matrix Card — custom Lovelace card for Home Assistant
 * Renders a visual call-routing matrix and toggles switch entities.
 *
 * Installation: add to Lovelace resources as a JavaScript module.
 * Usage:
 *   type: custom:dialmatrix-card
 *   title: "Call Routing Matrix"   # optional
 */

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
    this._config = config;
    this._render();
  }

  /**
   * Called by Lovelace whenever any entity state changes.
   * Only re-renders when matrix switches actually changed.
   */
  set hass(hass) {
    this._hass = hass;

    // Build a lightweight hash of only the matrix switch states
    const hash = Object.entries(hass.states)
      .filter(([, s]) => s.attributes.doorbell_id !== undefined)
      .map(([id, s]) => `${id}:${s.state}`)
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

  _getMatrixSwitches() {
    if (!this._hass) return [];
    return Object.values(this._hass.states).filter(
      (s) => s.attributes.doorbell_id !== undefined,
    );
  }

  _buildMatrix(switches) {
    const doorbellMap = new Map();
    const targetMap = new Map();

    for (const s of switches) {
      const { doorbell_id, doorbell_name, target_id, target_name } =
        s.attributes;
      if (!doorbellMap.has(doorbell_id))
        doorbellMap.set(doorbell_id, doorbell_name);
      if (!targetMap.has(target_id)) targetMap.set(target_id, target_name);
    }

    return {
      doorbells: [...doorbellMap.entries()].map(([id, name]) => ({ id, name })),
      targets: [...targetMap.entries()].map(([id, name]) => ({ id, name })),
    };
  }

  _findSwitch(switches, doorbellId, targetId) {
    return switches.find(
      (s) =>
        s.attributes.doorbell_id === doorbellId &&
        s.attributes.target_id === targetId,
    );
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

    const title = this._config.title || 'Call Routing Matrix';
    const switches = this._getMatrixSwitches();
    const { doorbells, targets } = this._buildMatrix(switches);

    const colTemplate =
      targets.length > 0
        ? `auto ${Array(targets.length).fill('minmax(44px, 1fr)').join(' ')}`
        : 'auto';

    // Header row
    let cells = `<div class="cell corner"></div>`;
    for (const t of targets) {
      cells += `<div class="cell th"><span class="th-text">${this._escape(t.name)}</span></div>`;
    }

    // Data rows
    for (const db of doorbells) {
      cells += `<div class="cell rh">${this._escape(db.name)}</div>`;
      for (const t of targets) {
        const sw = this._findSwitch(switches, db.id, t.id);
        if (sw) {
          const on = sw.state === 'on';
          cells += `
            <div class="cell">
              <button
                class="btn ${on ? 'on' : 'off'}"
                data-entity="${sw.entity_id}"
                title="${this._escape(db.name)} → ${this._escape(t.name)}: ${on ? 'enabled' : 'disabled'}"
                aria-pressed="${on}"
                aria-label="${this._escape(db.name)} to ${this._escape(t.name)}"
              >${on ? '✓' : '✗'}</button>
            </div>`;
        } else {
          cells += `<div class="cell"><span class="missing">–</span></div>`;
        }
      }
    }

    const emptyState =
      doorbells.length === 0
        ? `<p class="empty">No Dial Matrix switches found. Check your <code>configuration.yaml</code>.</p>`
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

        /* Row headers — doorbell names */
        .cell.rh {
          justify-content: flex-start;
          padding-right: 10px;
          font-size: 0.85em;
          font-weight: 500;
          color: var(--primary-text-color);
          white-space: nowrap;
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
          ${doorbells.length > 0 ? `<div class="grid">${cells}</div>` : ''}
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
    const switches = this._getMatrixSwitches();
    const { doorbells } = this._buildMatrix(switches);
    return Math.max(3, doorbells.length + 2);
  }

  // Stub config for the card picker UI
  static getStubConfig() {
    return { title: 'Call Routing Matrix' };
  }
}

customElements.define('dialmatrix-card', DialMatrixCard);

// Register with the Lovelace custom card registry
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'dialmatrix-card',
  name: 'Dial Matrix Card',
  description:
    'Visual call-routing matrix: selectively enable which notification targets receive each doorbell ring.',
  preview: true,
});
