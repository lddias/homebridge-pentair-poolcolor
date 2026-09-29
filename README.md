# homebridge-pentair-poolcolor

Exposes Pentair ScreenLogic pool light color control as a HomeKit **Lightbulb with only a color wheel** — no on/off. It's meant to sit next to the per-circuit on/off switches: those handle power, this handles color.

The Pentair protocol only supports fixed colors, so the wheel snaps to the nearest one:

| Wheel position | Sent to controller |
|---|---|
| Saturation below ~15% | White |
| Hue near red (0°) | Red |
| Hue near green (120°) | Green |
| Hue near blue (240°) | Blue |
| Hue near purple (285°) | Purple |

Notes:

- Sending a color powers the lights on — that's the Pentair controller's own behavior, not the plugin's. Use your circuit switches to turn lights off.
- Color commands are controller-wide: every light circuit that is on changes color together. That's a Pentair limitation, not the plugin's.

## Install

Via npm (once published), or through the Homebridge UI's plugin search:

```bash
npm install -g homebridge-pentair-poolcolor
```

> **Don't manually copy the plugin into `node_modules`.** npm treats unregistered
> folders there as extraneous and deletes them on the next plugin update.

Then add to the `accessories` array in `config.json`:

```json
{
  "accessory": "PentairPoolColor",
  "name": "Pool Light Color",
  "ip_address": "192.168.1.227"
}
```

Restart Homebridge. The accessory appears in the Home app as a light tile — long-press it to get the color wheel.

## Options

| Key | Required | Default | Description |
|---|---|---|---|
| `name` | yes | `Pool Light Color` | Name shown in the Home app. |
| `ip_address` | no | — | Static IP of the ScreenLogic protocol adapter. If unset, the plugin finds it via UDP broadcast on your LAN. |
| `port` | no | `80` | Port of the ScreenLogic protocol adapter. |
| `password` | no | — | ScreenLogic gateway password, if your adapter has one set. |

> **Why the static IP?** `node-screenlogic` discovers the adapter via UDP broadcast
> to `255.255.255.255`, which fails on some networks (VLANs, VPNs, certain
> routers). Passing `ip_address` skips discovery entirely. If your adapter ever
> gets a different DHCP address, update this field — or better, give the adapter
> a DHCP reservation.
