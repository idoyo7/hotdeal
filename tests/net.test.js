import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import { applyNetworkFamilyPolicy } from '../dist/net.js';

test('applyNetworkFamilyPolicy disables autoSelectFamily', () => {
  const original = net.getDefaultAutoSelectFamily();
  try {
    applyNetworkFamilyPolicy(false);
    assert.strictEqual(net.getDefaultAutoSelectFamily(), false);
  } finally {
    net.setDefaultAutoSelectFamily(original);
  }
});

test('applyNetworkFamilyPolicy enables autoSelectFamily', () => {
  const original = net.getDefaultAutoSelectFamily();
  try {
    applyNetworkFamilyPolicy(true);
    assert.strictEqual(net.getDefaultAutoSelectFamily(), true);
  } finally {
    net.setDefaultAutoSelectFamily(original);
  }
});
