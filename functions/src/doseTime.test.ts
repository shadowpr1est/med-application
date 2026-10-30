import test from 'node:test';
import assert from 'node:assert/strict';
import { localDoseAsUtc } from './doseTime.js';

test('converts the local schedule using its IANA timezone', () => {
  assert.equal(localDoseAsUtc('2026-10-27', '08:00', 'Asia/Qyzylorda').toISOString(), '2026-10-27T03:00:00.000Z');
  assert.equal(localDoseAsUtc('2026-01-15', '08:00', 'America/New_York').toISOString(), '2026-01-15T13:00:00.000Z');
  assert.equal(localDoseAsUtc('2026-07-15', '08:00', 'America/New_York').toISOString(), '2026-07-15T12:00:00.000Z');
});

test('keeps the UTC date boundary correct in positive offsets', () => {
  assert.equal(localDoseAsUtc('2026-03-08', '00:30', 'Asia/Tokyo').toISOString(), '2026-03-07T15:30:00.000Z');
});

test('resolves an ambiguous fall-back time to its first occurrence', () => {
  assert.equal(localDoseAsUtc('2026-11-01', '01:30', 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
});

test('moves a nonexistent spring-forward local time after the gap', () => {
  assert.equal(localDoseAsUtc('2026-03-08', '02:30', 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
});

test('rejects invalid date, time, and timezone input', () => {
  assert.throws(() => localDoseAsUtc('2026-15-01', '08:00', 'UTC'), RangeError);
  assert.throws(() => localDoseAsUtc('2026-02-31', '08:00', 'UTC'), RangeError);
  assert.throws(() => localDoseAsUtc('2026-10-27', '26:00', 'UTC'), RangeError);
  assert.throws(() => localDoseAsUtc('2026-10-27', '08:00', 'Unknown/Zone'), RangeError);
});
