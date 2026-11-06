import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { PLATFORMS } from '../../src/shared/platforms';

// activate.html (Firefox's settings-modal hand-off, see src/activate/index.ts)
// clones a brand icon per platform from inert <template>s. A platform that
// can be optional on any target without a template would get an icon-less
// button, so guard the list here.
describe('activate.html', () => {
  const html = readFileSync(path.join(__dirname, '../../activate.html'), 'utf8');
  const optionalSomewhere = PLATFORMS.filter(p => (p.optionalTargets ?? []).length > 0);

  it.each(optionalSomewhere.map(p => p.id))('has an icon template for %s', (id) => {
    expect(html).toContain(`<template id="platformIcon-${id}">`);
  });
});
