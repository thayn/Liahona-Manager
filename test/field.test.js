// Field dashboard logic: base-station lines in, commands out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, buildCommand, newField, apply, describeSend, freshness, signal, fitPlot, scaleBar, utf8Len, updateText } from '../public/shared/field.js';

test('parses base-station lines and ignores noise', () => {
  assert.equal(parseLine('I (149) boot: Disabling RNG'), null);
  assert.equal(parseLine('{"ev":"hello"'), null);
  assert.equal(parseLine('{"no":"ev"}'), null);
  assert.deepEqual(parseLine(' {"ev":"ack","ball":1,"ack_seq":2,"ok":true}\r'), { ev: 'ack', ball: 1, ack_seq: 2, ok: true });
});

test('builds commands the base station understands', () => {
  assert.equal(buildCommand('ping', 3), '{"cmd":"ping","to":3}');
  assert.equal(buildCommand('ping', 'all'), '{"cmd":"ping","to":"all"}');
  assert.equal(buildCommand('msg', '4', { text: ' Head to the river ' }), '{"cmd":"msg","to":4,"text":"Head to the river"}');
  assert.equal(buildCommand('stage', 2, { stage: '7' }), '{"cmd":"stage","to":2,"stage":7}');
  assert.equal(buildCommand('unlock', 'all'), '{"cmd":"unlock","to":"all"}');
  assert.equal(buildCommand('power', null, { dbm: 20 }), '{"cmd":"power","dbm":20}');
  assert.throws(() => buildCommand('ping', 0), /ball/);
  assert.throws(() => buildCommand('msg', 1, { text: '' }), /Type a message/);
  assert.throws(() => buildCommand('msg', 1, { text: 'é'.repeat(25) }), /48 bytes/);   // 50 bytes
  assert.throws(() => buildCommand('power', null, { dbm: 30 }), /-9 to 22/);
  assert.equal(utf8Len('é'), 2);
});

test('tracks balls, deliveries and the log', () => {
  const f = newField();
  apply(f, { ev: 'hello', fw: 'liahona-base 0.1.0', freq: 915000000, bw: 500, sf: 10, power: 14, tcxo: true }, 1000);
  assert.equal(f.base.sf, 10);

  apply(f, { ev: 'status', ball: 1, seq: 3, fix: false, lat: null, lon: null, batt: 4.0, low_batt: false, lid: 'open', stage: 0, heading: 108.3, rssi: -43, snr: 8.5 }, 2000);
  apply(f, { ev: 'status', ball: 1, seq: 4, fix: true, lat: 46.66, lon: -121.0, batt: 3.9, low_batt: false, lid: 'closed', stage: 2, heading: 10, rssi: -90, snr: -6.8 }, 32000);
  const b = f.balls[1];
  assert.equal(b.reports, 2);
  assert.equal(b.stage, 2);
  assert.equal(b.trail.length, 1);
  assert.equal(freshness(b, 32000 + 60e3), 'ok');
  assert.equal(freshness(b, 32000 + 120e3), 'stale');
  assert.equal(freshness(b, 32000 + 200e3), 'lost');

  const sent = apply(f, { ev: 'sent', type: 'msg', to: 1, seq: 5, ok: true }, 40000);
  sent.text = describeSend('msg', { text: 'Hi' });
  assert.equal(sent.state, 'waiting');
  apply(f, { ev: 'ack', ball: 1, ack_seq: 5, ok: true, rssi: -50, snr: 7 }, 41000);
  assert.equal(sent.state, 'delivered');
  assert.equal(f.log[0].text, 'Message: "Hi"');

  const s2 = apply(f, { ev: 'sent', type: 'command', to: 2, seq: 6, ok: true }, 42000);
  apply(f, { ev: 'timeout', type: 'command', to: 2, seq: 6 }, 47000);
  assert.equal(s2.state, 'no answer');

  const all = apply(f, { ev: 'sent', type: 'msg', to: 255, seq: 7, ok: true }, 48000);
  assert.equal(all.state, 'sent');
  assert.equal(all.ball, 'all');

  apply(f, { ev: 'checkin', ball: 1, seq: 9, uid: '04A1B2', station: 3, rssi: -60, snr: 5 }, 50000);
  assert.match(f.log[0].text, /station 3/);
});

test('signal and plot helpers', () => {
  assert.equal(signal(8).label, 'strong');
  assert.equal(signal(-6.8).label, 'weak');
  assert.equal(signal(undefined).bars, 0);
  assert.equal(fitPlot([], 400, 300), null);
  const fit = fitPlot([{ lat: 46.66, lon: -121.0 }, { lat: 46.661, lon: -121.0 }], 400, 300);
  const [x1, y1] = fit.project(46.66, -121.0);
  const [x2, y2] = fit.project(46.661, -121.0);
  assert.ok(y2 < y1, 'north is up');
  assert.ok(Math.abs(x1 - x2) < 0.01);
  const bar = scaleBar(fit.metresPerPx, 400);
  assert.ok(bar.px > 20 && bar.px < 400);
});

test('update progress from the balls', () => {
  const f = newField();
  assert.equal(buildCommand('update', 'all'), '{"cmd":"update","to":"all"}');
  const now = 1000;
  let e = apply(f, parseLine('{"ev":"update","ball":2,"state":"wifi","detail":0,"done":0,"total":0,"version":"0.4.0","rssi":-80,"snr":5}'), now);
  assert.match(e.text, /joining Wi-Fi/);
  assert.equal(apply(f, parseLine('{"ev":"update","ball":2,"state":"files","detail":0,"done":1,"total":3,"version":"0.4.0","rssi":-80,"snr":5}'), now), null);
  assert.match(updateText(f.balls[2].update), /files 1\/3/);
  e = apply(f, parseLine('{"ev":"update","ball":2,"state":"failed","detail":2,"done":1,"total":3,"version":"0.4.0","error":"couldn\'t join Wi-Fi","rssi":-80,"snr":5}'), now);
  assert.equal(e.kind, 'error');
  assert.match(e.text, /failed: couldn't join Wi-Fi/);
  e = apply(f, parseLine('{"ev":"update","ball":2,"state":"done","detail":0,"done":3,"total":3,"version":"0.5.0","rssi":-80,"snr":5}'), now);
  assert.match(e.text, /Updated: 3 files, firmware 0.5.0/);
  assert.equal(f.balls[2].version, '0.5.0');
});
