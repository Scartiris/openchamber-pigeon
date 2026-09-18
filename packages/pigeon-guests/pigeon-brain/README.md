# pigeon-brain guest

Pilot extension: rail / full-screen entry for the pigeon-brain memory library UI.

The management UI is still **pigeon-brain's own product**, reverse-proxied at
`/api/pigeon-brain/**`. This guest mounts that same-origin page from the
context rail and the Extension pages menu. Settings no longer lists a
记忆库 page; this panel is the workbench entry.

## Install (path)

1. Settings → Extensions → add absolute folder:
   `<repo>/packages/pigeon-guests/pigeon-brain`
2. Approve the panel capability (no extra capability needed).
3. Open the rail icon or Extension pages → 记忆库.

Requires `PIGEON_BRAIN_URL` on the OpenChamber server. Unconfigured installs
show a clear empty state and never proxy.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts \
  packages/pigeon-guests/pigeon-brain/panel/main.ts \
  packages/pigeon-guests/pigeon-brain/panel/main.js
```

Commit `panel/main.js`. Install never builds TypeScript.

## Boundary

- Settings no longer surfaces 记忆库; the guest panel owns the UI entry.
- Do not move SSH/device secrets into a guest package.
- OpenViking stays a first-class settings surface for now (edit/create/delete).
