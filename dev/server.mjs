// Local integration harness. No API credentials or external network calls.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8765);
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const state = { generations: 0, uploads: 0, failUpload: false, delay: 800, requests: [], files: {} };
const server = http.createServer(async (req, res) => {
    const reply = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    let body;
    if (req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply({ error: 'bad JSON' }, 400); } }
    if (pathname === '/mock/state') return reply({ ...state, files: Object.keys(state.files) });
    if (pathname === '/mock/control') { for (const key of ['failUpload', 'delay']) if (key in body) state[key] = body[key]; return reply({ ok: true }); }
    if (pathname === '/v1/models') return reply({ data: [{ id: 'gpt-image-2.5' }, { id: 'gpt-image-2.5-flare' }, { id: 'gpt-image-2.5-sunburst' }] });
    if (pathname === '/v1/images/generations') {
        state.generations++; state.requests.push(body);
        return setTimeout(() => reply({ data: [{ b64_json: pixel }] }), state.delay);
    }
    if (pathname === '/api/images/upload') {
        state.uploads++;
        if (state.failUpload) { state.failUpload = false; return reply({ error: '模拟：图片上传暂时失败' }, 500); }
        const saved = `/user/images/${body.filename}.${body.format}`; state.files[saved] = Buffer.from(body.image, 'base64'); return reply({ path: saved });
    }
    if (state.files[pathname]) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(state.files[pathname]); }
    const relative = pathname === '/' ? 'dev/demo.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local mock: http://127.0.0.1:${port}`));
