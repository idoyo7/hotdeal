import assert from 'node:assert/strict';
import test from 'node:test';

import { getConfig } from '../dist/config.js';

const withEnv = (entries, run) => {
  const previous = new Map();
  for (const key of Object.keys(entries)) {
    previous.set(key, process.env[key]);
    const value = entries[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test('getConfig disables legacy DOM fallback scrape by default', () => {
  withEnv({ ENABLE_LEGACY_DOM_FALLBACK_SCRAPE: undefined }, () => {
    const config = getConfig();
    assert.strictEqual(config.enableLegacyDomFallbackScrape, false);
  });
});

test('getConfig enables legacy DOM fallback scrape when env is true', () => {
  withEnv({ ENABLE_LEGACY_DOM_FALLBACK_SCRAPE: 'true' }, () => {
    const config = getConfig();
    assert.strictEqual(config.enableLegacyDomFallbackScrape, true);
  });
});
