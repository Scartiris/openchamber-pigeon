# syntax=docker/dockerfile:1
#
# LibreOffice document conversion service for the OpenChamber preview surface.
#
# Deliberately small: a slim Debian base, the three LibreOffice document
# applications, CJK fonts, and the Python standard library. There is no document
# editor, no browser engine and no database here — the service only ever turns a
# document into a PDF, which is what makes it affordable next to the document
# server it replaces.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/var/lib/office-convert \
    OFFICE_CONVERT_PORT=8000 \
    OFFICE_CONVERT_CACHE_DIR=/var/cache/office-convert \
    OFFICE_CONVERT_PROFILE_DIR=/var/lib/office-convert/profile \
    OFFICE_CONVERT_CACHE_BYTES=536870912 \
    OFFICE_CONVERT_TIMEOUT_SECONDS=120

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-noto-cjk \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-writer \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY server.py /usr/local/bin/office-convert.py

# Run unprivileged: LibreOffice is a large desktop application pointed at
# user-supplied documents, and nothing here needs root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin converter \
    && mkdir -p "$OFFICE_CONVERT_CACHE_DIR" "$HOME" \
    && chown -R converter:converter "$OFFICE_CONVERT_CACHE_DIR" "$HOME"
USER converter

# Build the shared LibreOffice profile once, so the first real conversion does
# not pay for first-start initialisation.
RUN soffice --headless --invisible --nologo --nodefault --nolockcheck --norestore \
      -env:UserInstallation=file://${OFFICE_CONVERT_PROFILE_DIR} \
      --terminate_after_init \
    && test -d "${OFFICE_CONVERT_PROFILE_DIR}"

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).status == 200 else 1)"

ENTRYPOINT ["python3", "/usr/local/bin/office-convert.py"]
