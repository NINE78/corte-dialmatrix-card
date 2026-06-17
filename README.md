# Dial Matrix Card

A custom [Lovelace](https://www.home-assistant.io/dashboards/) card for [Home Assistant](https://www.home-assistant.io/) that renders a visual call-routing matrix. Each cell is a toggle button that enables or disables which notification targets receive a ring from a given doorbell.

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)

## Features

- Visual grid of doorbells (rows) × notification targets (columns)
- One-tap toggle buttons — green ✓ for enabled, outlined ✗ for disabled
- Automatically discovers switch entities that expose `doorbell_id` / `target_id` attributes
- Only re-renders when matrix switch states actually change
- Responsive, scrollable grid with rotated column headers
- Fully themed via Home Assistant CSS variables

## Installation

### HACS (recommended)

1. Open **HACS → Frontend** in Home Assistant.
2. Click the **⋮** menu → **Custom repositories**.
3. Add this repository URL and choose category **Lovelace**.
4. Install **Dial Matrix Card** and reload the browser.

### Manual

1. Download `dialmatrix-card.js` from the [latest release](../../releases/latest).
2. Copy it to `<config>/www/dialmatrix-card.js`.
3. Add it as a Lovelace resource:
   - **Settings → Dashboards → Resources → Add resource**
   - URL: `/local/dialmatrix-card.js`
   - Type: **JavaScript module**
4. Reload the browser.

## Usage

Add the card to any dashboard view:

```yaml
type: custom:dialmatrix-card
title: Call Routing Matrix # optional, defaults to "Call Routing Matrix"
```

## Switch entity requirements

The card discovers switches automatically. Each switch entity must expose the following attributes:

| Attribute       | Type   | Description                                            |
| --------------- | ------ | ------------------------------------------------------ |
| `doorbell_id`   | string | Unique identifier for the doorbell (row)               |
| `doorbell_name` | string | Display name for the doorbell                          |
| `target_id`     | string | Unique identifier for the notification target (column) |
| `target_name`   | string | Display name for the notification target               |

The `state` of the switch (`on` / `off`) determines whether that doorbell → target route is active.

## Screenshot

> Add a screenshot of the card here.

## License

MIT
