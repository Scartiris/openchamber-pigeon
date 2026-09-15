/**
 * Minimal Google Drive REST client using fetch — no googleapis dependency.
 * Only what cold tiering needs: ensure folder, upload, download, delete.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const encodeMultipart = (metadata, bytes, boundary) => {
  const head = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, bytes, tail]);
};

export const createDriveClient = ({ getAccessToken, fetchImpl = fetch }) => {
  const authorized = async () => {
    const token = await getAccessToken();
    if (!token) {
      throw Object.assign(new Error('Google Drive is not connected'), { status: 501, code: 'drive_not_connected' });
    }
    return { Authorization: `Bearer ${token}` };
  };

  const ensureRootFolder = async () => {
    const headers = await authorized();
    const query = encodeURIComponent("name = 'OpenChamber Artifacts' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
    const listResponse = await fetchImpl(`${DRIVE_API}/files?q=${query}&spaces=drive&fields=files(id,name)&pageSize=1`, {
      headers,
    });
    if (!listResponse.ok) {
      throw Object.assign(new Error(`Drive folder lookup failed (${listResponse.status})`), { status: 502 });
    }
    const listed = await listResponse.json();
    if (listed.files?.[0]?.id) return listed.files[0].id;

    const createResponse = await fetchImpl(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'OpenChamber Artifacts',
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    if (!createResponse.ok) {
      throw Object.assign(new Error(`Drive folder create failed (${createResponse.status})`), { status: 502 });
    }
    const created = await createResponse.json();
    return created.id;
  };

  const ensureArtifactFolder = async ({ parentId, title }) => {
    const headers = await authorized();
    const query = encodeURIComponent(
      `name = '${title.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    );
    const listResponse = await fetchImpl(`${DRIVE_API}/files?q=${query}&fields=files(id,name)&pageSize=1`, {
      headers,
    });
    if (!listResponse.ok) {
      throw Object.assign(new Error(`Drive artifact folder lookup failed (${listResponse.status})`), { status: 502 });
    }
    const listed = await listResponse.json();
    if (listed.files?.[0]?.id) return listed.files[0].id;

    const createResponse = await fetchImpl(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: title,
        parents: [parentId],
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    if (!createResponse.ok) {
      throw Object.assign(new Error(`Drive artifact folder create failed (${createResponse.status})`), { status: 502 });
    }
    const created = await createResponse.json();
    return created.id;
  };

  const uploadBlob = async ({ parentId, name, bytes, mimeType }) => {
    const headers = await authorized();
    const boundary = `oc-artifacts-${Date.now().toString(36)}`;
    const body = encodeMultipart(
      { name, parents: [parentId], mimeType: mimeType || 'application/octet-stream' },
      bytes,
      boundary,
    );
    const response = await fetchImpl(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,size`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`Drive upload failed (${response.status}) ${detail.slice(0, 200)}`), {
        status: 502,
      });
    }
    return response.json();
  };

  const downloadBlob = async ({ fileId }) => {
    const headers = await authorized();
    const response = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Drive download failed (${response.status})`), { status: 502 });
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };

  const deleteFile = async ({ fileId }) => {
    const headers = await authorized();
    const response = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok && response.status !== 404) {
      throw Object.assign(new Error(`Drive delete failed (${response.status})`), { status: 502 });
    }
  };

  return {
    ensureRootFolder,
    ensureArtifactFolder,
    uploadBlob,
    downloadBlob,
    deleteFile,
  };
};
