# Connecting Herdr — runbook

Bring the Herdr read-only terminal leg up end to end: install herdr-core, run
the relay, expose it on the tailnet, then pair it from the phone setup form.
QA for the whole path lives in this repo, so the runbook does too.

## 1. What it is

The path a Herdr terminal frame travels to reach the glasses:

```
phone setup form → wss://g2-bridge.taile61e1.ts.net/herdr → tailscale serve (TLS)
  → 127.0.0.1:8700 herdr-relay → unix socket → herdr-core
```

The glasses app opens a **separate, read-only** WebSocket to the relay. The
Hermes bridge socket is never touched by anything on this page.

## 2. Install herdr-core

```
curl -fsSL https://releases.herdr.dev/core/install.sh | sh
```

(This is the install line from the herdr-core README — copy it from there, not
from memory, if it ever changes.)

Check: `herdr-core serve` is running and the socket exists at
`/run/user/$(id -u)/herdr-core/default.sock`.

## 3. Run the relay

```
cd ~/work/g2-hermes/herdr-relay
export HERDR_RELAY_TOKEN=$(openssl rand -hex 24)   # store it in the password manager
HERDR_RELAY_PORT=8700 .venv/bin/python -m herdr_relay
```

- It refuses to start without a token (`herdr_relay/__main__.py`).
- `HERDR_RELAY_HOST` defaults to `127.0.0.1`; keep that — the relay must not
  listen beyond localhost.
- Set `HERDR_SOCK` only for a non-default herdr-core socket
  (`herdr_relay/herdr_client.py`).

## 4. Expose it on the already-whitelisted host

```
docker exec g2-tailscale tailscale serve --bg --set-path=/herdr http://127.0.0.1:8700
```

- Check with `docker exec g2-tailscale tailscale serve status`.
- Any host other than `g2-bridge.taile61e1.ts.net` is blocked by the app.json
  whitelist — the app will not connect to it.
- **Never use Funnel.** Serve is tailnet-only; Funnel would publish the relay
  to the public internet.

## 5. On the phone

Hermes setup → **Herdr relay (optional)** panel:

1. Relay URL: `wss://g2-bridge.taile61e1.ts.net/herdr`
2. Relay token: the `HERDR_RELAY_TOKEN` value from step 3
3. Press **Save relay**

The status dot next to the bridge dot shows `◇ herdr connected`, and Herdr
terminals appear in the unified session list. Clearing both fields and saving
turns the leg off.

## 6. Troubleshooting by dot

Read the `◇ herdr <status>` dot on the config screen:

| Dot | Meaning | Fix |
| --- | --- | --- |
| `connecting` / `reconnecting` | relay or `tailscale serve` is down | steps 3–4 |
| `rejected` | wrong token | fix the token, press **Save relay** again (this re-dials; the client gives up permanently on a rejected token until you re-save) |
| no dot at all | fields empty or invalid | read the inline error under the form |

## 7. Security note: the token rides `?token=`

A browser WebSocket cannot set an `Authorization` header, so the relay token
travels in the URL query string (`?token=…`). It can therefore appear in proxy
or relay logs, and in WebView devtools. That is acceptable **on the tailnet
only** — never expose this URL via Funnel or a public host.

To rotate: restart the relay with a new `HERDR_RELAY_TOKEN`, then re-save the
token on the phone.

## 8. Teardown

```
docker exec g2-tailscale tailscale serve --set-path=/herdr off   # confirm with `serve status`
pkill -f 'python -m herdr_relay'
```

Then clear both phone fields and press **Save relay** — the leg goes off, the
rows drop, and the dot disappears.
