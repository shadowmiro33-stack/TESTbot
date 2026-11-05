// 포트가 열릴 때까지 대기: node scripts/wait-port.mjs <port> [timeoutSec]
import net from 'node:net';
const [port, timeout = '120'] = process.argv.slice(2);
const deadline = Date.now() + Number(timeout) * 1000;
const tryOnce = () => new Promise((resolve) => { const s = net.connect(Number(port), '127.0.0.1'); s.once('connect', () => { s.end(); resolve(true); }); s.once('error', () => resolve(false)); });
while (Date.now() < deadline) { if (await tryOnce()) { console.log(`port ${port} ready`); process.exit(0); } await new Promise((r) => setTimeout(r, 1000)); }
console.error(`port ${port} not ready after ${timeout}s`); process.exit(1);
