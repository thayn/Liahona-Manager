// Settings → Balls over Wi-Fi: which Journey the balls get, the ball key, the
// wifi.json for each ball's SD card, and the firmware the balls install.
// The balls fetch all of this themselves when the Field dashboard sends Update.

let H;   // helpers from app.js: api, toast, esc, can
export function initBalls(helpers) { H = helpers; }

const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`;

export async function renderBalls(root) {
  const { esc, can } = H;
  root.innerHTML = '<div class="panel"><h3>Balls over Wi-Fi</h3><p class="muted">Loading…</p></div>';
  let ball, journeys;
  try {
    [ball, journeys] = await Promise.all([H.api('GET', '/api/ball'), H.api('GET', '/api/journeys')]);
  } catch (e) {
    root.innerHTML = `<div class="panel"><h3>Balls over Wi-Fi</h3><p class="bad-text">${esc(e.message)}</p></div>`;
    return;
  }
  const admin = can('admin');
  const fw = ball.firmware;
  root.innerHTML = `
    <div class="panel">
      <h3>Balls over Wi-Fi</h3>
      <p class="hint">Press <strong>Update</strong> on the Field tab and each ball joins Wi-Fi, downloads the Journey, roster and audio below, and installs new firmware if there is one. It reports back over the radio.</p>
      <div class="row">
        <label class="grow">Journey on the balls
          <select id="ball-journey">
            <option value="">None yet</option>
            ${journeys.map(j => `<option value="${esc(j.id)}"${j.id === ball.journeyId ? ' selected' : ''}>${esc(j.title || j.id)}</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="hint">Audio in the Journey's media folder goes too (MP3 and WAV).</p>

      <h4>Firmware</h4>
      <p>${fw ? `Version <strong class="mono">${esc(fw.version)}</strong>, ${kb(fw.size)}, uploaded ${esc(new Date(fw.at).toLocaleString())}` : '<span class="muted">None uploaded. The balls keep the firmware they have.</span>'}</p>
      ${admin ? `<div class="row">
        <input type="file" id="ball-fw-file" accept=".bin" class="grow">
        <button class="primary" id="ball-fw-upload">Upload</button>
        ${fw ? '<button class="small ghost" id="ball-fw-clear">Stop offering it</button>' : ''}
      </div>
      <p class="hint">Use <span class="mono">firmware/build/liahona_fw.bin</span> from your build. A ball installs it only if the version differs from what it runs, and goes back to its old firmware if the new one doesn't start.</p>` : ''}

      ${admin ? `<h4>Wi-Fi file for the SD cards</h4>
      <p class="hint">Each ball reads <span class="mono">liahona/wifi.json</span> on its SD card. Make it once and copy it to every ball. Use a 2.4 GHz network; the balls can't see 5 GHz.</p>
      <div class="row">
        <label class="grow">Network name <input id="ball-ssid" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. Thayn's iPhone"></label>
        <label class="grow">Password <input id="ball-pass" type="password" autocomplete="new-password"></label>
      </div>
      <div class="row">
        <label class="grow">Manager address <input id="ball-url" value="${esc(location.origin)}" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="hint">${H.mode() === 'local' ? 'On the camp laptop, use the laptop\'s address on the camp Wi-Fi (like http://192.168.1.20:3000), not localhost.' : 'The cloud address works anywhere the network reaches the internet, including a phone hotspot.'}</p>
      <div class="row">
        <span class="grow muted">Ball key: ${ball.hasKey ? 'set' : 'not made yet'}</span>
        <button class="small ghost" id="ball-newkey">${ball.hasKey ? 'Make a new key' : 'Make a key'}</button>
        <button class="primary" id="ball-wifi" ${ball.hasKey ? '' : 'disabled'}>Download wifi.json</button>
      </div>
      <p class="hint">The key lets a ball download your Journey and roster. Treat the file like a password. A new key locks out every wifi.json made before it.</p>` : ''}
    </div>`;

  const $ = (s) => root.querySelector(s);
  $('#ball-journey').addEventListener('change', async (e) => {
    try { await H.api('PATCH', '/api/ball', { journeyId: e.target.value || null }); H.toast('The balls will get this Journey on their next update'); }
    catch (err) { H.toast(err.message, true); renderBalls(root); }
  });
  if (!admin) return;

  $('#ball-fw-upload').addEventListener('click', async () => {
    const f = $('#ball-fw-file').files[0];
    if (!f) return H.toast('Choose liahona_fw.bin first', true);
    if (f.size > 8 * 1048576) return H.toast('That file is over 8 MB', true);
    const btn = $('#ball-fw-upload');
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const data = await toBase64(f);
      const r = await H.api('POST', '/api/ball/firmware', { name: f.name, data });
      H.toast(`Firmware ${r.firmware.version} is ready for the balls`);
      renderBalls(root);
    } catch (err) { H.toast(err.message, true); btn.disabled = false; btn.textContent = 'Upload'; }
  });
  $('#ball-fw-clear')?.addEventListener('click', async () => {
    if (!confirm('Stop offering this firmware? Balls keep what they already have.')) return;
    try { await H.api('DELETE', '/api/ball/firmware'); renderBalls(root); } catch (err) { H.toast(err.message, true); }
  });
  $('#ball-newkey').addEventListener('click', async () => {
    if (ball.hasKey && !confirm('Make a new ball key? Every wifi.json made before stops working until you copy the new one to the balls.')) return;
    try { await H.api('POST', '/api/ball/key'); renderBalls(root); } catch (err) { H.toast(err.message, true); }
  });
  $('#ball-wifi').addEventListener('click', async () => {
    const ssid = $('#ball-ssid').value.trim(), password = $('#ball-pass').value;
    const manager = $('#ball-url').value.trim().replace(/\/+$/, '');
    if (!ssid) return H.toast('Type the network name', true);
    if (!/^https?:\/\/[^\s/]+/.test(manager)) return H.toast('The Manager address starts with http:// or https://', true);
    if (/localhost|127\.0\.0\.1/.test(manager)) return H.toast('Use the laptop\'s address on the Wi-Fi, not localhost; the balls can\'t reach localhost', true);
    let key;
    try { key = (await H.api('GET', '/api/ball')).key; } catch (err) { return H.toast(err.message, true); }
    const body = JSON.stringify({ ssid, password, manager, key }, null, 2) + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = 'wifi.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Couldn\'t read that file'));
    r.readAsDataURL(file);
  });
}
