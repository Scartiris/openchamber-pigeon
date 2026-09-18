# Fleet Module Documentation

## Purpose

One aggregate snapshot for the header chip: the **workbench host** (memory, disk,
network, load, containers, deploy ledger) plus **every registered device** (the
same resource set, read over the device SSH channel).

It exists because the two halves have different sources and only one of them can
be read from inside the container:

| Data | Source | Why not the obvious way |
|---|---|---|
| Host memory / disk | `host-metrics.json` **or** in-process `/proc` | in-process is already accurate: the container's `/proc/meminfo` and `df` are the host's |
| Host network | `host-metrics.json` only | the container has its own netns; `-v /proc/net/dev:…:ro` is overridden by Docker's own `/proc`, so the container can only ever see its own `eth0` |
| Host containers | `host-metrics.json` only | no docker socket is mounted (deliberately) |
| Device metrics | `devices.metrics` tool over SSH | same transport/approval/audit path as every other device action |

## Entrypoints

- `index.js` — composition root (`createFleetRuntime`).
- `host-metrics.js` — reads and normalizes the host helper file; falls back to
  in-process `/proc` collection with `network: null` and explicit `notes`.
- `snapshot.js` — composes host + devices, owns the TTL caches, single-flight,
  and the byte-rate computation (two cumulative samples).
- `routes.js` — HTTP surface.

## HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/fleet/status` | UI session (`/api` middleware) | Full snapshot; `?refresh=1` bypasses the server TTL |
| `GET /api/fleet/host` | UI session | Host + summary only (scripted checks) |

## TTLs

| Layer | TTL | Note |
|---|---|---|
| Snapshot | 10s | server-side; the chip polls every 30s |
| Device status (TCP probe) | 10s | wraps `devices/status.js` |
| Device metrics (SSH) | 30s | the expensive one; rates are computed over this window |

## Invariants

- **No invented numbers.** A missing reading is `null` (rendered `—`); a first
  byte-rate sample is `null`, never `0`.
- **Host staleness is reported**, not hidden: `host.ageMs` / `host.stale`
  (default 60s) plus `notes: ['host-helper-stale']`.
- **The host network column does not exist without the helper.** The in-process
  fallback marks `network-unavailable`; the panel then shows "unavailable" and a
  hint instead of drawing the container's traffic as the host's.
- **A device only gets metrics when its transport answered.** Offline devices
  still appear, with `error.code = device_offline`.
- **Failures are explicit**: `transport_unavailable`, `approval_required`,
  `permission_denied`, `metrics_parse_failed`, `timeout`, `upstream_error`.
- **Timer-driven reads are not audited** (`callTool({ audit: false })`), or the
  500-entry device audit ring would be flushed within hours. Direct agent calls
  of `devices.metrics` stay audited.
- Device rate windows use the **workbench clock**, not the device's: a device
  with a wrong clock must not produce absurd rates or a bogus stale flag.

## Response shape

```jsonc
{
  "checkedAt": "ISO", "cached": false,
  "host": { "ok": true, "source": "helper|in-process|missing", "ageMs": 3200, "stale": false,
            "notes": [], "hostname": "pigeoncore", "platform": "linux",
            "uptimeSec": 0, "cpu": { "count": 4, "load1": 0, "load5": 0, "load15": 0 },
            "memory": { "totalBytes": 0, "availableBytes": 0, "usedBytes": 0,
                        "usedPercent": 0, "swapTotalBytes": 0, "swapUsedBytes": 0, "swapUsedPercent": 0 },
            "disks": [ { "mount": "/", "filesystem": "/dev/vda1", "totalBytes": 0, "usedBytes": 0,
                         "availBytes": 0, "usedPercent": 0 } ],
            "network": { "windowSec": 15,
                         "interfaces": [ { "name": "ens3", "rxBytes": 0, "txBytes": 0,
                                           "rxBytesPerSec": 0, "txBytesPerSec": 0 } ],
                         "totalRxBytesPerSec": 0, "totalTxBytesPerSec": 0 },
            "containers": [ { "name": "openchamber", "image": "…", "state": "running",
                              "health": "healthy", "status": "…" } ],
            "containersSummary": { "total": 3, "running": 3, "healthy": 3, "unhealthy": 0 },
            "deploy": { "sha": "…", "image": "…", "previousImage": "…", "at": "…" } },
  "devices": { "checkedAt": "ISO", "total": 1, "onlineCount": 1, "items": [
    { "id": "dev_…", "name": "relay", "platform": "linux", "approval": "smart",
      "online": true, "latencyMs": 2, "transport": "tailscale|tunnel",
      "metrics": { "…": "same resource fields as host" },
      "metricsAgeMs": 0, "metricsStale": false, "error": null } ] },
  "summary": { "severity": "ok|warn|error", "hostOk": true, "hostStale": false,
               "hostMemPercent": 0, "hostDiskPercent": 0, "worstDiskPercent": 0,
               "devicesTotal": 1, "devicesOnline": 1,
               "devicesWithMetrics": 1, "devicesWithErrors": 0 }
}
```

Severity: `error` when the host is unavailable/stale or memory/disk ≥ 90%;
`warn` when a device is offline, a device's metrics failed, or memory/disk ≥ 80%.

## Host helper contract

`oc-host-metrics` (see `ops/host/` in the pigeoncore repository) writes the file
**atomically** (tmp + `mv`) every 15s, mode 0644, at
`${OC_HOST_METRICS_OUT:-<compose data dir>/openchamber/host-metrics.json}`.
The path can be overridden for the reader with `OPENCHAMBER_HOST_METRICS_FILE`.
The helper never fails as a whole: per-item problems land in `errors[]`.

## Tests

`fleet.test.js` — host normalization, staleness, the in-process fallback and its
notes, snapshot TTL/single-flight, byte rates from two samples, offline devices,
metric failure propagation, and the severity matrix.
