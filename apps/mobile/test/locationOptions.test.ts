import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRACKING_CONFIG } from '@geo/shared';
import { nativeOptions } from '../src/locationOptions.ts';

test('cada modo produce opciones nativas coherentes y sin pausa automática', () => {
  for (const mode of ['battery_saver', 'normal', 'trip', 'intensive'] as const) {
    const o = nativeOptions(mode, DEFAULT_TRACKING_CONFIG[mode]);
    assert.equal(o.pausesUpdatesAutomatically, false);
    assert.equal(o.showsBackgroundLocationIndicator, true);
    assert.ok(o.timeInterval >= 1000);
  }
  assert.ok(nativeOptions('battery_saver', DEFAULT_TRACKING_CONFIG.battery_saver).distanceInterval > nativeOptions('intensive', DEFAULT_TRACKING_CONFIG.intensive).distanceInterval);
  assert.equal(nativeOptions('trip', DEFAULT_TRACKING_CONFIG.trip).activityType, 'automotive');
});
