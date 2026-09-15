# Dial Matrix Card

A custom [Lovelace](https://www.home-assistant.io/dashboards/) card for [Home Assistant](https://www.home-assistant.io/) that renders a visual event-routing matrix. Each cell is a toggle button that enables or disables which notification targets are alerted for a given event source: a doorbell ring, or a [Frigate](https://frigate.video) person / car detection on a camera.

Companion card for the [Dial Matrix](https://github.com/NINE78/corte-dialmatrix) integration.

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)

## Features

- Visual grid of event sources (rows) × notification targets (columns)
- **Routing editor in the card's edit dialog**: add and edit doorbells, Frigate cameras, notification targets and Frigate settings where you edit the card — no YAML, no integration dialogs
- Rows grouped by event type — **Doorbells**, **Person detected**, **Car detected** — with icons
- One-tap toggle buttons — green ✓ for enabled, outlined ✗ for disabled
- Automatically discovers the integration's switch entities; no entity lists to maintain
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

### Editing the routing configuration

Open the dashboard's edit mode and edit the card. Below the card options the dialog shows the **Routing** editor with four sections:

- **Doorbells** — ID, name and the MQTT topic that rings it (the payload is used as Frigate event id, so the push gets the snapshot).
- **Cameras (Frigate)** — ID, name, Frigate camera name, the labels that get a row (person, car, …) and, per label, the zones an object must enter before anyone is notified.
- **Notification targets** — ID, name and notify service. Expand *Messages, push extras and TTS* for the push titles/messages, extra push data (JSON such as `{"url": "/dashboard/gate", "ttl": 0, "priority": "high"}`) and the speaker settings: the text-to-speech engine and the notify service are dropdowns, speakers are a checkbox list of your media players, plus announcement volume and *Announce* (on Sonos and similar players the music is ducked, the message plays at the set volume, and the music resumes at its previous level).
- **Frigate settings** — listen to Frigate over MQTT, the topic, and the push image URL.

**Save routing** validates the form and stores it in the Dial Matrix integration, which reloads; the preview and the grid update within a second. This is independent of the dialog's own Save button, which only stores the card options (title, filters). **Discard changes** reloads the form from the integration. Only admins can save.

Message placeholders: `$icon`, `$doorbell_name`, `$camera_name`, `$label`, `$label_title`, `$sub_label`, `$zones`.

Set `editable: true` to also get a pencil button on the card itself that opens the same editor inline, without entering dashboard edit mode.

Requires the Dial Matrix integration to be added once under **Settings → Devices & services** (or imported from YAML); the card then does the rest.

### Options

| Option        | Default                | Description                                                                                          |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `title`       | `Call Routing Matrix`  | Card title                                                                                           |
| `show_title`  | `true`                 | Set to `false` to hide the header and save vertical space                                            |
| `editable`    | `false`                | Also show a pencil button on the card that opens the routing editor inline                           |
| `event_types` | all                    | Only show these event types, e.g. `[doorbell]` or `[person, car]`                                    |
| `group_rows`  | `true`                 | Insert a header row per event type. When `false`, camera rows get an inline icon instead             |
| `type_labels` | see below              | Override group header text per event type, e.g. `{ person: 'People', car: 'Vehicles' }`              |
| `type_icons`  | see below              | Override group icons per event type, e.g. `{ car: 'mdi:car-side' }`                                  |

Built-in labels / icons: `doorbell` → _Doorbells_ / `mdi:doorbell`, `person` → _Person detected_ / `mdi:walk`, `car` → _Car detected_ / `mdi:car`. Any other Frigate label configured in the integration (e.g. `dog`) gets a _Dog detected_ header with a generic icon.

Example — two cards, one for the doorbells and one for camera detections:

```yaml
- type: custom:dialmatrix-card
  title: Doorbells
  event_types: [doorbell]
  group_rows: false

- type: custom:dialmatrix-card
  title: Camera alerts
  event_types: [person, car]
  type_labels:
    person: People
    car: Vehicles
```

## Switch entity requirements

The card discovers switches automatically. Each switch entity must expose the following attributes (the Dial Matrix integration does this for you):

| Attribute     | Type   | Description                                                                    |
| ------------- | ------ | ------------------------------------------------------------------------------ |
| `source_id`   | string | Unique identifier for the event source (row)                                   |
| `source_name` | string | Display name for the source (doorbell or camera name)                          |
| `event_type`  | string | `doorbell`, `person`, `car`, … — determines the row group                      |
| `target_id`   | string | Unique identifier for the notification target (column)                         |
| `target_name` | string | Display name for the notification target                                       |
| `sort_order`  | list   | Optional list of integers used to order rows and columns as configured         |

Switches from older integration versions that only expose `doorbell_id` / `doorbell_name` are still recognised and shown as doorbell rows.

The `state` of the switch (`on` / `off`) determines whether that source → target route is active.

## Screenshot

> Add a screenshot of the card here.

## License

MIT
