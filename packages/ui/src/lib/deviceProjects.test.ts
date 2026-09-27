import { describe, expect, test } from 'bun:test';
import { parseDeviceDirectoryListing } from './deviceProjects';

describe('parseDeviceDirectoryListing', () => {
  test('parses a PowerShell array of directories', () => {
    const stdout = JSON.stringify([
      { Mode: 'd----', Name: 'proj', Length: 0, LastWriteTime: '2026-01-01' },
      { Mode: '-a---', Name: 'file.txt', Length: 3, LastWriteTime: '2026-01-01' },
    ]);
    const entries = parseDeviceDirectoryListing(stdout, 'C:/Users/alice');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: 'proj', path: 'C:/Users/alice/proj', isDirectory: true });
    expect(entries[1].isDirectory).toBe(false);
  });

  test('parses a single object and empty output', () => {
    const single = parseDeviceDirectoryListing(
      JSON.stringify({ Mode: 'd----', Name: 'only' }),
      'C:/Users/alice',
    );
    expect(single).toEqual([{ name: 'only', path: 'C:/Users/alice/only', isDirectory: true }]);
    expect(parseDeviceDirectoryListing('', 'C:/x')).toEqual([]);
    expect(parseDeviceDirectoryListing('not-json', 'C:/x')).toEqual([]);
  });
});
