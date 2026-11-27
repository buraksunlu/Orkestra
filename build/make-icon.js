// Renders build/icon.png (1024x1024) from build/logo-source.jpg (black conductor silhouette on white).
// The silhouette is cut out of its white background, drawn light on the app's dark rounded tile, under a
// soft stage light, with the green "done" glow at the baton tip.
// Also writes src/assets/logo-mark.png (sidebar logo) and src/assets/trayTemplate.png (+ @2x): the bare silhouette, black on transparent, for the macOS
// menu bar (a template image: macOS colours it for light and dark menu bars).
// Run: npm run icon   (this script, then build/make-icns.sh)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const src = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'logo-source.jpg')).toString('base64');

const html = `<html><body style="margin:0;background:transparent"><canvas id="c" width="1024" height="1024"></canvas>
<script>
const img = new Image();
img.onload = () => {
  const N = 1024;
  // 1. Silhouette mask: dark pixels opaque, the white (slightly vignetted) background transparent.
  const a = document.createElement('canvas'); a.width = a.height = N;
  const ax = a.getContext('2d');
  ax.drawImage(img, 0, 0, N, N);
  const d = ax.getImageData(0, 0, N, N);
  let x0 = N, y0 = N, x1 = 0, y1 = 0;
  for (let i = 0; i < N * N; i++) {
    const p = i * 4;
    const lum = 0.299 * d.data[p] + 0.587 * d.data[p + 1] + 0.114 * d.data[p + 2];
    const al = Math.max(0, Math.min(255, Math.round((215 - lum) * 255 / 165)));
    d.data[p] = 236; d.data[p + 1] = 240; d.data[p + 2] = 244; d.data[p + 3] = al;
    if (al > 60) {
      const x = i % N, y = (i / N) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  ax.putImageData(d, 0, 0);

  // 2. Tile: macOS icon grid (824px rounded square inside 1024).
  const c = document.getElementById('c').getContext('2d');
  const T = 100, S = 824, R = 185;
  c.save();
  c.beginPath(); c.roundRect(T, T, S, S, R); c.clip();
  const bg = c.createLinearGradient(0, T, 0, T + S);
  bg.addColorStop(0, '#1d242d'); bg.addColorStop(1, '#0a0c0f');
  c.fillStyle = bg; c.fillRect(T, T, S, S);

  // 3. Fit the silhouette: 62% of the tile's height, centred, a little low so the stage sits near the bottom.
  const bw = x1 - x0, bh = y1 - y0;
  const k = (S * 0.62) / bh;
  const dw = bw * k, dh = bh * k;
  const dx = 512 - dw / 2, dy = 512 - dh / 2 + 22;

  // Stage light from above onto the conductor.
  const sl = c.createRadialGradient(512, dy + dh * 0.55, 20, 512, dy + dh * 0.55, S * 0.55);
  sl.addColorStop(0, 'rgba(255,236,190,0.16)'); sl.addColorStop(1, 'rgba(255,236,190,0)');
  c.fillStyle = sl; c.fillRect(T, T, S, S);

  c.drawImage(a, x0, y0, bw, bh, dx, dy, dw, dh);

  // 4. Green glow at the baton tip: the topmost silhouette pixel right of centre.
  let tx = 0, ty = N;
  for (let y = y0; y < y1 && ty === N; y++)
    for (let x = Math.round((x0 + x1) / 2) + 40; x <= x1; x++)
      if (d.data[(y * N + x) * 4 + 3] > 120) { tx = x; ty = y; break; }
  const gx = dx + (tx - x0) * k, gy = dy + (ty - y0) * k;
  const g = c.createRadialGradient(gx, gy, 0, gx, gy, 95);
  g.addColorStop(0, 'rgba(133,223,94,0.95)'); g.addColorStop(0.18, 'rgba(133,223,94,0.55)'); g.addColorStop(1, 'rgba(133,223,94,0)');
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = g; c.fillRect(gx - 100, gy - 100, 200, 200);
  c.globalCompositeOperation = 'source-over';
  c.restore();

  // Thin rim like the old icon.
  c.beginPath(); c.roundRect(T + 3, T + 3, S - 6, S - 6, R - 3);
  c.lineWidth = 6; c.strokeStyle = 'rgba(255,255,255,0.09)'; c.stroke();

  // 5. Menu bar template: black silhouette, fitted to the full height (macOS menu bar icons are ~18pt).
  const tray = (px) => {
    const t = document.createElement('canvas'); t.width = t.height = px;
    const tx2 = t.getContext('2d');
    const kk = (px * 0.96) / bh;
    const w2 = bw * kk, h2 = bh * kk;
    tx2.drawImage(a, x0, y0, bw, bh, (px - w2) / 2, (px - h2) / 2, w2, h2);
    tx2.globalCompositeOperation = 'source-in';
    tx2.fillStyle = '#000'; tx2.fillRect(0, 0, px, px);
    return t.toDataURL('image/png');
  };
  // 6. Logo mark for the app's own sidebar: light silhouette, green glow at the baton tip, transparent.
  const mark = (px) => {
    const m = document.createElement('canvas'); m.width = m.height = px;
    const mx = m.getContext('2d');
    const kk = (px * 0.9) / bh;
    const w2 = bw * kk, h2 = bh * kk;
    const ox = (px - w2) / 2, oy = (px - h2) / 2 + px * 0.03;
    mx.drawImage(a, x0, y0, bw, bh, ox, oy, w2, h2);
    const gx2 = ox + (tx - x0) * kk, gy2 = oy + (ty - y0) * kk, r = px * 0.16;
    const gg = mx.createRadialGradient(gx2, gy2, 0, gx2, gy2, r);
    gg.addColorStop(0, 'rgba(133,223,94,1)'); gg.addColorStop(0.25, 'rgba(133,223,94,0.6)'); gg.addColorStop(1, 'rgba(133,223,94,0)');
    mx.globalCompositeOperation = 'lighter';
    mx.fillStyle = gg; mx.fillRect(gx2 - r, gy2 - r, r * 2, r * 2);
    return m.toDataURL('image/png');
  };
  window.out = { tray1: tray(18), tray2: tray(36), mark: mark(128) };
  document.title = 'ready';
};
img.src = ${JSON.stringify(src)};
</script></body></html>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  for (let i = 0; i < 50 && w.getTitle() !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  const out = await w.webContents.executeJavaScript('window.out');
  const assets = path.join(__dirname, '..', 'src', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const png = (u) => Buffer.from(u.split(',')[1], 'base64');
  fs.writeFileSync(path.join(assets, 'trayTemplate.png'), png(out.tray1));
  fs.writeFileSync(path.join(assets, 'trayTemplate@2x.png'), png(out.tray2));
  fs.writeFileSync(path.join(assets, 'logo-mark.png'), png(out.mark));
  app.quit();
});
