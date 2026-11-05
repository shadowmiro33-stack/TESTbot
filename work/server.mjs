import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
const root = path.resolve('work');
createServer((request, response) => {
  const target = path.join(root, request.url === '/health.json' ? 'health.json' : 'demo.html');
  response.setHeader('Content-Type', target.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8');
  createReadStream(target).pipe(response);
}).listen(4179, '127.0.0.1');
