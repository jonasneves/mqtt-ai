# MQTT AI Dashboard

Browser dashboard for controlling physical robots with AI. Runs entirely in the browser — no backend.

## Architecture

The AI model runs in the browser and publishes MQTT tool calls directly to the broker. The ESP32 subscribes on the other end. Both sides default to a local Mosquitto broker on your laptop — everything stays on your LAN, no cloud dependency. Public brokers are available as a fallback in the dashboard preset menu.

![Architecture and sequence diagrams](diagram.png)

## Prerequisites

- ESP32-CAM-MB (AI Thinker) or any ESP32 dev board with CP210x USB-to-serial
- [Homebrew](https://brew.sh/) — to install host dependencies
- One of the following for the AI chat:
  - Anthropic API key — entered in the dashboard settings
  - GitHub account — sign in via GitHub Models (no API key needed)
  - Claude Code subscription — run `make proxy` to use your personal account

## Quickstart

**1. Install host dependencies** (once per machine)
```bash
make setup
```
After install, macOS will prompt you to allow the CP210x driver in **System Preferences > Privacy & Security**. Do that before flashing.

**2. Configure credentials** (first time only)
```bash
cp config.mk.example config.mk
```
Edit `config.mk` with your WiFi SSID and password. `PORT` is auto-detected — only override it if needed.

**3. Start the local MQTT broker**

```bash
make mqtt
```

This runs Mosquitto on your laptop (port 1883 for the ESP32, port 9001 for the dashboard's WebSocket). Leave it running in its own terminal.

**4. Flash firmware** (first time, via USB)

Choose a sketch based on your hardware:

```bash
make flash-monitor            # LED control (any ESP32)
make flash-car && make monitor  # Motor control via L298N (ESP32-CAM-MB)
```

The Makefile auto-detects your laptop's LAN IP and bakes it into the firmware as the broker address. If detection fails or you need a different interface, set `MQTT_IP` in `config.mk`.

After boot, the ESP32 prints its unique topic prefix (e.g. `devices/d4e9f4a2a044/`) and its local IP. Add the IP to `config.mk` as `ESP32_IP` to enable OTA updates.

**5. Open the dashboard**

Go to [neevs.io/mqtt-ai](https://neevs.io/mqtt-ai) (or run `make preview` for localhost:8080) and click **Connect** — it defaults to `ws://localhost:9001`, the broker you started in step 3. Topics appear automatically.

**6. Control your robot**

Browse topics and publish manually, or open the AI chat panel, choose your AI provider, and describe what you want the robot to do.

If you flashed `esp32_car`, selecting the `motors/command` topic shows a D-pad with a speed slider. Hold a direction button to drive; release to stop. Arrow keys work too.

## OTA updates

After the first USB flash, subsequent firmware updates go over WiFi:

```bash
make ota        # LED sketch
make ota-car    # Motor sketch
```

Requires `ESP32_IP` set in `config.mk` (printed by the ESP32 on boot).

## Public broker fallback

Local-first is the default. If LAN discovery is impractical for your setup (e.g. a demo on a guest network that blocks peer-to-peer traffic, or cross-network testing), the dashboard preset menu includes public HiveMQ and test.mosquitto.org brokers. Set `MQTT_IP = broker.hivemq.com` in `config.mk` to point the firmware at the same one. Topics are world-readable on public brokers — don't use them for anything sensitive.

## Local Claude proxy (optional)

To use the AI chat with your Claude Code subscription instead of an API key:

```bash
cp .env.example .env  # set CLAUDE_CODE_OAUTH_TOKEN inside
make proxy
```

This starts a local proxy at `http://127.0.0.1:7337` that forwards requests directly to `api.anthropic.com` using your OAuth token. Select **Claude · Personal account** as the model in dashboard settings.

## WebMCP (experimental)

The dashboard also registers MQTT tools via the [W3C WebMCP spec](https://github.com/webmachinelearning/webmcp) (`navigator.modelContext`), exposing them to native browser AI agents — not just the built-in chat. Requires Chrome 146+ Canary with `chrome://flags/#webmcp-for-testing`. The chat works without it.
