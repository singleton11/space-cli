import { describe, expect, it } from 'vitest';
import { projectParam } from '../../src/lib/project.js';

describe('projectParam', () => {
  it('prefixes bare project keys with key: (bare keys 404 live)', () => {
    expect(projectParam('IJ')).toBe('key:IJ');
    expect(projectParam('amper')).toBe('key:amper');
  });
  it('passes explicit identifiers through untouched', () => {
    expect(projectParam('key:IJ')).toBe('key:IJ');
    expect(projectParam('id:3EBSUZ2RmBPZ')).toBe('id:3EBSUZ2RmBPZ');
  });
  it('passes bare project ids through only when explicitly prefixed', () => {
    // A bare id *looks* like a key to us — the id: escape hatch exists for this.
    expect(projectParam('3EBSUZ2RmBPZ')).toBe('key:3EBSUZ2RmBPZ');
  });
});
