#!/usr/bin/env python3
"""LibreOffice document conversion service.

Turns a Word / Excel / PowerPoint / ODF / RTF / CSV document into a PDF so the
workbench can preview it with the browser's own PDF viewer instead of running a
full document-editing server.

    GET  /health              -> 200 {"status": "ok", "soffice": "<version>"}
    GET  /cache/<key>         -> 200 application/pdf | 404
    POST /convert/<key>?name=<file>
                              -> 200 application/pdf
                               | 400 bad key/name, 413 body too large,
                               | 422 the converter produced no PDF

`<key>` is an opaque caller-chosen identity for one document version (the
workbench uses sha1(path|mtime|size)). The service only ever uses it as a cache
file name, so it knows nothing about the machine it is serving.

Design notes, in the order they matter on a small host:

* **One conversion at a time.** LibreOffice is a desktop application: several
  concurrent headless runs multiply peak memory by their count, and this service
  exists because the previous preview engine did exactly that. Requests queue on
  a lock; the wait is bounded by the caller's own timeout.
* **The profile is shared and pre-built.** A per-run `UserInstallation` pays
  LibreOffice's first-start cost on every conversion. Serialising conversions
  makes one shared profile safe, and the image builds it once.
* **Every run is killable.** Conversions get their own process group and are
  killed by group on timeout, because `soffice` re-execs children that outlive a
  kill aimed at the parent alone.
* **The cache is bounded.** Converted PDFs are kept in the cache directory and
  pruned oldest-first to a byte budget, so a directory of large spreadsheets
  cannot fill the disk.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("OFFICE_CONVERT_PORT", "8000"))
CACHE_DIR = Path(os.environ.get("OFFICE_CONVERT_CACHE_DIR", "/var/cache/office-convert"))
PROFILE_DIR = os.environ.get("OFFICE_CONVERT_PROFILE_DIR", "/var/lib/office-convert/profile")
CACHE_BYTES = int(os.environ.get("OFFICE_CONVERT_CACHE_BYTES", str(512 * 1024 * 1024)))
MAX_INPUT_BYTES = int(os.environ.get("OFFICE_CONVERT_MAX_INPUT_BYTES", str(100 * 1024 * 1024)))
MAX_OUTPUT_BYTES = int(os.environ.get("OFFICE_CONVERT_MAX_OUTPUT_BYTES", str(256 * 1024 * 1024)))
TIMEOUT_SECONDS = int(os.environ.get("OFFICE_CONVERT_TIMEOUT_SECONDS", "120"))

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
EXTENSION_PATTERN = re.compile(r"^[A-Za-z0-9]{1,8}$")

CONVERSION_LOCK = threading.Lock()
SOFFICE_VERSION = None


def soffice_version():
    """The version string, or None when the converter is not usable."""
    try:
        completed = subprocess.run(
            ["soffice", "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = (completed.stdout or completed.stderr or "").strip()
    return output or None


def prune_cache():
    """Drop the oldest cached PDFs until the cache fits its byte budget."""
    try:
        entries = [(p, p.stat()) for p in CACHE_DIR.glob("*.pdf")]
    except OSError:
        return

    total = sum(stat.st_size for _, stat in entries)
    if total <= CACHE_BYTES:
        return

    for path, stat in sorted(entries, key=lambda entry: entry[1].st_mtime):
        if total <= CACHE_BYTES:
            break
        try:
            path.unlink()
            total -= stat.st_size
        except OSError:
            # A file being served right now can refuse to go; it will be a
            # candidate again on the next conversion.
            continue


def convert_to_pdf(key, extension, source_bytes):
    """Run one conversion. Returns (bytes, None) or (None, error_reason)."""
    workdir = tempfile.mkdtemp(prefix="office-convert-")
    try:
        source_path = Path(workdir) / f"{key}.{extension}"
        source_path.write_bytes(source_bytes)
        outdir = Path(workdir) / "out"
        outdir.mkdir()

        command = [
            "soffice",
            "--headless",
            "--invisible",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--norestore",
            f"-env:UserInstallation=file://{PROFILE_DIR}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(outdir),
            str(source_path),
        ]

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            # Its own process group: a timeout has to take the whole tree with
            # it, or a half-finished conversion keeps holding memory.
            start_new_session=True,
        )
        try:
            output, _ = process.communicate(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            _kill_process_group(process)
            process.communicate()
            print(f"conversion timed out after {TIMEOUT_SECONDS}s: {key}", flush=True)
            return None, "conversion-timeout"

        if process.returncode != 0:
            print(
                f"soffice exited {process.returncode} for {key}: "
                f"{(output or b'').decode('utf-8', 'replace')[:500]}",
                flush=True,
            )
            return None, "conversion-failed"

        produced = sorted(outdir.glob("*.pdf"))
        if not produced:
            print(
                f"soffice produced no PDF for {key}: "
                f"{(output or b'').decode('utf-8', 'replace')[:500]}",
                flush=True,
            )
            return None, "conversion-failed"

        pdf = produced[0].read_bytes()
        if not pdf:
            return None, "conversion-failed"
        if len(pdf) > MAX_OUTPUT_BYTES:
            print(f"converted PDF for {key} exceeds the output budget", flush=True)
            return None, "too-large"
        return pdf, None
    except OSError as error:
        print(f"conversion failed for {key}: {error}", flush=True)
        return None, "conversion-failed"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _kill_process_group(process):
    try:
        os.killpg(os.getpgid(process.pid), 9)
    except OSError:
        try:
            process.kill()
        except OSError:
            pass


class ConversionHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "office-convert"

    def log_message(self, fmt, *args):
        # The default logs one line per request to stderr; keep them, but on
        # stdout with the rest of the service output so `docker logs` is one
        # ordered stream.
        print(f"{self.address_string()} {fmt % args}", flush=True)

    def _send_json(self, status, payload, close=False):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _send_pdf(self, payload):
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(payload)))
        # Callers key the URL by file version, not by content, so a cached copy
        # in a browser or proxy would be able to outlive the document it shows.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/health":
            if SOFFICE_VERSION:
                return self._send_json(200, {"status": "ok", "soffice": SOFFICE_VERSION})
            return self._send_json(503, {"status": "unavailable", "reason": "soffice-missing"})

        if path.startswith("/cache/"):
            key = path[len("/cache/"):]
            if not KEY_PATTERN.match(key):
                return self._send_json(400, {"error": "invalid key"})
            cached = CACHE_DIR / f"{key}.pdf"
            try:
                payload = cached.read_bytes()
            except OSError:
                return self._send_json(404, {"error": "not converted"})
            if not payload:
                return self._send_json(404, {"error": "not converted"})
            return self._send_pdf(payload)

        return self._send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/convert/"):
            return self._send_json(404, {"error": "not found"}, close=True)

        key = parsed.path[len("/convert/"):]
        if not KEY_PATTERN.match(key):
            return self._send_json(400, {"error": "invalid key"}, close=True)

        if not SOFFICE_VERSION:
            return self._send_json(503, {"error": "soffice-missing"}, close=True)

        name = urllib.parse.parse_qs(parsed.query).get("name", [""])[0]
        extension = Path(name).suffix.lstrip(".").lower()
        if not EXTENSION_PATTERN.match(extension):
            return self._send_json(400, {"error": "name must carry a file extension"}, close=True)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send_json(400, {"error": "invalid content-length"}, close=True)

        if length <= 0:
            return self._send_json(400, {"error": "empty body"}, close=True)
        if length > MAX_INPUT_BYTES:
            # The body is deliberately left unread; `close=True` keeps the
            # connection from being reused with an unread body on it.
            return self._send_json(413, {"error": "document too large"}, close=True)

        cached = CACHE_DIR / f"{key}.pdf"
        try:
            payload = cached.read_bytes()
            if payload:
                return self._send_pdf(payload)
        except OSError:
            pass

        source_bytes = self._read_body(length)
        if source_bytes is None:
            return self._send_json(400, {"error": "incomplete body"}, close=True)

        with CONVERSION_LOCK:
            # Another request may have converted this exact version while this
            # one was queued; the cache is checked again under the lock.
            try:
                payload = cached.read_bytes()
                if payload:
                    return self._send_pdf(payload)
            except OSError:
                pass

            started = time.monotonic()
            pdf, reason = convert_to_pdf(key, extension, source_bytes)
            elapsed = time.monotonic() - started

            if pdf is None:
                self._send_json(422, {"error": reason or "conversion-failed"}, close=True)
                return

            try:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                temporary = CACHE_DIR / f".{key}.{os.getpid()}.tmp"
                temporary.write_bytes(pdf)
                os.replace(temporary, cached)
            except OSError as error:
                # A cache that cannot be written is a performance problem, not
                # a correctness one: the caller still gets its PDF.
                print(f"failed to cache {key}: {error}", flush=True)

            prune_cache()
            print(f"converted {key} ({extension}, {len(source_bytes)} -> {len(pdf)} bytes) in {elapsed:.1f}s", flush=True)
            return self._send_pdf(pdf)

    def _read_body(self, length):
        remaining = length
        chunks = []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1024 * 1024))
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)


def main():
    global SOFFICE_VERSION

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    SOFFICE_VERSION = soffice_version()
    if SOFFICE_VERSION:
        print(f"office-convert ready: {SOFFICE_VERSION}", flush=True)
    else:
        print("office-convert started without a usable soffice binary", flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", PORT), ConversionHandler)
    server.daemon_threads = True
    print(f"office-convert listening on :{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
