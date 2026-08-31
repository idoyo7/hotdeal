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

test('getConfig disables network family auto-select by default', () => {
  withEnv({ NETWORK_AUTO_SELECT_FAMILY: undefined }, () => {
    const config = getConfig();
    assert.strictEqual(config.networkAutoSelectFamily, false);
  });
});

test('getConfig enables network family auto-select when env is true', () => {
  withEnv({ NETWORK_AUTO_SELECT_FAMILY: 'true' }, () => {
    const config = getConfig();
    assert.strictEqual(config.networkAutoSelectFamily, true);
  });
});

test('getConfig defaults delivery retry settings', () => {
  withEnv({ DELIVERY_MAX_ATTEMPTS: undefined, DELIVERY_RETRY_BASE_MS: undefined }, () => {
    const config = getConfig();
    assert.strictEqual(config.deliveryMaxAttempts, 3);
    assert.strictEqual(config.deliveryRetryBaseMs, 500);
  });
});

test('getConfig reads delivery retry settings from env', () => {
  withEnv({ DELIVERY_MAX_ATTEMPTS: '5', DELIVERY_RETRY_BASE_MS: '1000' }, () => {
    const config = getConfig();
    assert.strictEqual(config.deliveryMaxAttempts, 5);
    assert.strictEqual(config.deliveryRetryBaseMs, 1000);
  });
});
