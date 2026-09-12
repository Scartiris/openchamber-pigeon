import { describe, expect, it } from 'vitest';

import { DOCUMENT_PREVIEW_EXTENSIONS, getDocumentPreviewKind } from '@openchamber/ui/lib/toolHelpers';

import { DOCUMENT_PREVIEW_KINDS } from './routes.js';

/**
 * The client and the server each carry their own extension table — one in
 * TypeScript for what the panel offers to open, one in JavaScript for what the
 * route will mint a configuration for. They are written in different languages
 * and nothing else holds them together, so a format added on one side only
 * would show up as a link that opens a preview which then refuses to load.
 */
describe('document preview extension tables', () => {
  it('agrees with the client on every extension the server accepts', () => {
    const extensions = Object.keys(DOCUMENT_PREVIEW_KINDS);
    expect(extensions.length).toBeGreaterThan(0);

    for (const extension of extensions) {
      expect(getDocumentPreviewKind(`report.${extension}`)).toBe(DOCUMENT_PREVIEW_KINDS[extension]);
    }
  });

  it('agrees with the client on every extension the client offers', () => {
    const extensions = Object.keys(DOCUMENT_PREVIEW_EXTENSIONS);
    expect(extensions.length).toBeGreaterThan(0);

    for (const extension of extensions) {
      expect(DOCUMENT_PREVIEW_KINDS[extension]).toBe(DOCUMENT_PREVIEW_EXTENSIONS[extension]);
    }
  });

  it('does not preview formats neither side knows', () => {
    for (const extension of ['txt', 'zip', 'png', 'mp4', 'md']) {
      expect(DOCUMENT_PREVIEW_KINDS[extension]).toBeUndefined();
      expect(getDocumentPreviewKind(`report.${extension}`)).toBeNull();
    }
  });
});
