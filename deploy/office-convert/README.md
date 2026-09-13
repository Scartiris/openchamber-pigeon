# office-convert

LibreOffice in a container, behind a four-endpoint HTTP API, so the workbench can
preview Word / Excel / PowerPoint / ODF / RTF / CSV files as PDF.

The preview surface used to render office files with an OnlyOffice Document
Server: a 6.5 GB image, a 2.5 GB memory ceiling, a JWT handshake, and a public
HTTPS origin for the editor to load from. None of that is needed to *look* at a
document. This service converts the document to PDF and the browser renders it.

| | |
|---|---|
| Contract | `deploy/office-convert/server.py` (see the module docstring) |
| Client | `packages/web/server/lib/doc-preview/converter.js` |
| Routes that use it | `packages/web/server/lib/doc-preview/routes.js` |
| Env var that enables previews | `OPENCHAMBER_DOC_PREVIEW_URL` |

## API

| Route | Answer |
|---|---|
| `GET /health` | `200 {"status":"ok","soffice":"LibreOffice 7.4.7.2"}` — or `503` when `soffice` is unusable. |
| `GET /cache/<key>` | The converted PDF, or `404` when this version has not been converted yet. |
| `POST /convert/<key>?name=<file>` | The converted PDF. Body is the document bytes. `413` over the input budget, `422` when no PDF came out. |

`<key>` is chosen by the caller and is only ever used as a cache file name
(`^[A-Za-z0-9_-]{1,128}$`); the workbench passes `sha1(path|mtime|size)`. `name`
only has to carry the file extension — that is what tells LibreOffice which
import filter to use.

## Build and run

```sh
docker build -t pigeon-office-convert:1 deploy/office-convert

docker run -d --name office-convert \
  --network pigeon-net \
  --memory 1536m --memory-swap 1536m \
  -v /opt/openchamber-pigeon/data/office-convert-cache:/var/cache/office-convert \
  --restart unless-stopped \
  pigeon-office-convert:1
```

The service publishes no host port: only the OpenChamber container talks to it,
over the compose network, and the browser never sees it.

The bind-mounted cache directory must be writable by uid `10001` (the image's
`converter` user):

```sh
install -d -o 10001 -g 10001 /opt/openchamber-pigeon/data/office-convert-cache
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OFFICE_CONVERT_PORT` | `8000` | Listen port. |
| `OFFICE_CONVERT_CACHE_DIR` | `/var/cache/office-convert` | Where converted PDFs are kept. |
| `OFFICE_CONVERT_PROFILE_DIR` | `/var/lib/office-convert/profile` | Shared LibreOffice user profile, built into the image. |
| `OFFICE_CONVERT_CACHE_BYTES` | `536870912` (512 MiB) | Cache budget; the oldest entries are pruned first. |
| `OFFICE_CONVERT_MAX_INPUT_BYTES` | `104857600` (100 MiB) | Rejects larger uploads with `413`. Keep in step with the workbench's `MAX_PREVIEW_BYTES`. |
| `OFFICE_CONVERT_MAX_OUTPUT_BYTES` | `268435456` (256 MiB) | A conversion that overshoots this is reported as `too-large`. |
| `OFFICE_CONVERT_TIMEOUT_SECONDS` | `120` | Per-conversion budget; the process group is killed on expiry. |

## Operational notes

- **One conversion at a time.** Requests queue on a lock inside the service. A
  LibreOffice run peaks in the hundreds of megabytes, so the container's memory
  limit is the real concurrency limit — do not raise concurrency here without
  raising that limit deliberately.
- **The profile is shared and pre-built** during `docker build`. Serialising
  conversions is what makes one profile safe, and pre-building it keeps
  LibreOffice's first-start cost out of the first user-visible conversion.
- **Timeouts kill the process group**, because `soffice` re-execs children that
  survive a kill aimed only at the parent.
- **Failed conversions are per document.** A document that cannot be converted
  answers `422` for that request only; the service stays up and the next
  document converts normally.

## Fonts

The image installs `fonts-noto-cjk` and `fonts-liberation`. Documents that ask
for fonts nobody has (the common `仿宋_GB2312` / `方正小标宋` pair in Chinese
government templates, for instance) are rendered with LibreOffice's substitution
— Noto Serif CJK for serif faces, Noto Sans CJK for sans — so text stays legible
instead of turning into boxes. To pin specific substitutions, add a font
replacement table to the profile at build time.
