import { describe, expect, it } from 'vitest';

import {
  albumKey,
  fileKey,
  folderKey,
  libraryKey,
  memoryKey,
  parseAdminResourceKey,
} from './resourceKeys';

const lib = 'lib1';

describe('resourceKeys', () => {
  it('builds a library key as the raw library id', () => {
    expect(libraryKey(lib)).toBe('lib1');
  });

  it('builds a folder key with an f: marker per segment', () => {
    expect(folderKey(lib, '2024/Japan')).toBe('lib1/f:2024/f:Japan');
    expect(folderKey(lib, '2024')).toBe('lib1/f:2024');
  });

  it('treats an empty or root folder path as the library key', () => {
    expect(folderKey(lib, '')).toBe('lib1');
    expect(folderKey(lib, '/')).toBe('lib1');
  });

  it('builds a file key with folder markers plus a terminal x: marker', () => {
    expect(fileKey(lib, '2024/Japan/IMG_0001.jpg')).toBe('lib1/f:2024/f:Japan/x:IMG_0001.jpg');
  });

  it('builds a top-level file key with no folder markers', () => {
    expect(fileKey(lib, 'IMG_0001.jpg')).toBe('lib1/x:IMG_0001.jpg');
  });

  it('builds album and memory keys with their entity marker', () => {
    expect(albumKey(lib, 'alb1')).toBe('lib1/a:alb1');
    expect(memoryKey(lib, 'mem1')).toBe('lib1/m:mem1');
  });
});

describe('parseAdminResourceKey', () => {
  it('parses the library: label', () => {
    expect(parseAdminResourceKey(lib, 'library:')).toBe('lib1');
    expect(parseAdminResourceKey(lib, 'library:lib1')).toBe('lib1');
  });

  it('parses the folder: label, with or without the redundant library id', () => {
    expect(parseAdminResourceKey(lib, 'folder:2024/Japan')).toBe('lib1/f:2024/f:Japan');
    expect(parseAdminResourceKey(lib, 'folder:lib1/2024/Japan')).toBe('lib1/f:2024/f:Japan');
  });

  it('parses the file: label, with or without the redundant library id', () => {
    expect(parseAdminResourceKey(lib, 'file:2024/IMG_0001.jpg')).toBe('lib1/f:2024/x:IMG_0001.jpg');
    expect(parseAdminResourceKey(lib, 'file:lib1/IMG_0001.jpg')).toBe('lib1/x:IMG_0001.jpg');
  });

  it('passes an already-canonical or unrecognized key through unchanged', () => {
    expect(parseAdminResourceKey(lib, 'lib1/a:alb1')).toBe('lib1/a:alb1');
    expect(parseAdminResourceKey(lib, 'lib1/t:vacation')).toBe('lib1/t:vacation');
  });
});
