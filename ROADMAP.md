# Roadmap

Current state: browser dashboard with AI chat + MQTT topic browser, LED firmware, motor control firmware (D-pad), OTA updates.

---

## 1 — Unblock hardware (immediate)

- [ ] Install CP210x driver (`make setup`) and allow it in System Preferences → Privacy & Security
- [ ] Confirm ESP32-CAM-MB appears on `/dev/cu.usbserial-*` or `/dev/cu.SLAB_USBtoUART`
- [ ] `make flash-monitor` with `esp32_led` — confirm LED topic appears in dashboard
- [ ] Wire L298N, `make flash-car` — confirm motor topic appears; test D-pad

---

## 2 — Sensors

Each sensor gets its own state topic, published by the ESP32 at a fixed rate. The dashboard already handles any topic — no dashboard changes needed, just firmware.

- [ ] **HC-SR04 (distance)** — add to `esp32_car`: publish `devices/<mac>/distance/state` (cm) at ~10 Hz
- [ ] **IR line sensor (MH)** — publish `devices/<mac>/ir/state` (0/1 per sensor)
- [ ] **Encoders** — publish `devices/<mac>/encoders/state` (`{"left": 1234, "right": 1230}` tick counts)
- [ ] **Camera stream** — publish JPEG frames or serve MJPEG over local IP; link from dashboard

---

## 3 — Parameters

Live tuning without reflashing. The ESP32 subscribes to a params topic and persists values in NVS.

- [ ] **Firmware** — subscribe to `devices/<mac>/params/set` (`{"key": "max_speed", "value": 0.8}`); publish current params on `devices/<mac>/params/state` at connect
- [ ] **Dashboard** — detect `params/state` topics and show a key/value editor panel (get current value, edit inline, publish to `params/set`)

This directly enables the team goal of "tune parameters live without editing code."

---

## 4 — Discovery graph

Visual graph of devices and their topic connections — beginner-facing alternative to the flat topic list.

- [ ] Parse device announcements into a device → topics map
- [ ] Render a simple node graph: device nodes connected to topic nodes (D3 force layout or hand-rolled SVG)
- [ ] Click a node to select the topic in the main panel

---

## 5 — Multi-device / launch

- [ ] Support multiple ESP32s on the same broker (already works via MAC-based topics; just needs a multi-device demo)
- [ ] Launch file concept: a JSON/YAML file listing device IDs and their expected topics, used to pre-populate the dashboard on load

---

## 6 — Robot abstraction (API layer)

Wraps raw MQTT into the `robot.motors.set_speed()` pattern from the project vision.

- [ ] Define a Python client library (`pip install physical-agents`) that talks MQTT underneath
- [ ] Auto-discovers devices by prefix; exposes `robot.motors`, `robot.distance`, `robot.ir`, `robot.encoders`
- [ ] Synchronous imperative API for beginners; opt-in streaming via `for reading in robot.distance.stream()`

---

## 7 — Integration demo

End-to-end demo suitable for showing to the team / recruiting students.

- [ ] Robot drives forward, stops when HC-SR04 reads < 20 cm
- [ ] AI chat in dashboard: "drive forward until you hit something" — AI uses publish_sequence + subscribe_once tools
- [ ] Record short video for documentation

---

## Parking lot

Ideas to revisit once the above is stable:

- Simulation mode (replay recorded topic streams against the dashboard without hardware)
- WebRTC for low-latency camera feed in the dashboard
- Community platform / challenge map
- ROS2 bridge (topics bridged to/from ROS via MQTT)
