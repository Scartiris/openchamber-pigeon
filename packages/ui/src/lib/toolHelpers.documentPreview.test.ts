import { describe, expect, test } from 'bun:test';

import { getDocumentPreviewKind, isDocumentPreviewable } from './toolHelpers';

describe('document preview classification', () => {
  test('maps office and open-document formats to their document type', () => {
    expect(getDocumentPreviewKind('report.docx')).toBe('word');
    expect(getDocumentPreviewKind('legacy.doc')).toBe('word');
    expect(getDocumentPreviewKind('notes.odt')).toBe('word');
    expect(getDocumentPreviewKind('budget.xlsx')).toBe('cell');
    expect(getDocumentPreviewKind('legacy.xls')).toBe('cell');
    expect(getDocumentPreviewKind('data.csv')).toBe('cell');
    expect(getDocumentPreviewKind('deck.pptx')).toBe('slide');
    expect(getDocumentPreviewKind('legacy.ppt')).toBe('slide');
    expect(getDocumentPreviewKind('slides.odp')).toBe('slide');
  });

  test('keeps pdf on the native viewer', () => {
    expect(getDocumentPreviewKind('report.pdf')).toBe('pdf');
    expect(isDocumentPreviewable('report.pdf')).toBe(true);
  });

  test('is case-insensitive and path aware', () => {
    expect(getDocumentPreviewKind('/repo/docs/REPORT.DOCX')).toBe('word');
    expect(getDocumentPreviewKind('C:\\repo\\docs\\deck.PPTX')).toBe('slide');
    expect(getDocumentPreviewKind('归档/报告.docx')).toBe('word');
  });

  test('rejects everything else', () => {
    for (const filePath of ['notes.txt', 'index.ts', 'archive.zip', 'image.png', 'script.sh', 'README', 'draft.docx.bak']) {
      expect(isDocumentPreviewable(filePath)).toBe(false);
      expect(getDocumentPreviewKind(filePath)).toBeNull();
    }
  });
});
