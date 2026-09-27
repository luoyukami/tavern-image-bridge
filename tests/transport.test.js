import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, apiRequest, createImageId, extractImage, loadSettings, routeRequest } from '../core.js';
import { createService } from '../service.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const settings = { ...DEFAULTS, apiKey: 'api-test-key' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'st-csrf', Authorization: 'Basic private-login', 'X-Private-Header': 'do-not-forward' };

test('new installs default to server; legacy settings keep direct mode; explicit selection persists', () => {
    assert.equal(loadSettings().transport, 'server');
    assert.equal(loadSettings({ baseUrl: 'http://old-host/v1' }).transport, 'direct');
    assert.equal(loadSettings({ baseUrl: 'http://host/v1', transport: 'server' }).transport, 'server');
    assert.equal(loadSettings({ rememberKey: false, apiKey: 'old-key' }).apiKey, '');
});

test('server model request is same-origin and retains ST session, with only required headers', async () => {
    let captured;
    await apiRequest(settings, 'models', { requestHeaders: stHeaders, fetchImpl: async (url, options) => { captured = { url, options }; return json({ data: [] }); } });
    assert.equal(captured.url, '/proxy/http%3A%2F%2F127.0.0.1%3A8317%2Fv1%2Fmodels');
    assert.equal(captured.options.credentials, 'same-origin');
    assert.equal(captured.options.headers.Authorization, 'Bearer api-test-key');
    assert.equal(captured.options.headers['X-CSRF-Token'], 'st-csrf');
    assert.equal(captured.options.headers['X-Private-Header'], undefined);
    assert.equal(captured.options.body, undefined);
    assert.equal(captured.options.redirect, 'error');
});

test('server generation sends the Images payload unchanged through the proxy', async () => {
    let captured;
    await apiRequest({ ...settings, baseUrl: 'http://cliproxy:8317/v1/images/generations' }, 'generate', { prompt: '雨夜', fetchImpl: async (url, options) => { captured = { url, options }; return json({ data: [{ b64_json: png }] }); } });
    assert.equal(decodeURIComponent(captured.url.slice('/proxy/'.length)), 'http://cliproxy:8317/v1/images/generations');
    assert.equal(captured.options.method, 'POST');
    assert.deepEqual(JSON.parse(captured.options.body), { model: 'gpt-image-2.5', prompt: '雨夜', n: 1, size: '1024x1024', quality: 'auto', output_format: 'png', stream: false });
});

test('direct mode excludes ST credentials and leaves API URL absolute', () => {
    const { url, options } = routeRequest({ ...settings, transport: 'direct' }, 'http://api.test/v1/models', { requestHeaders: stHeaders });
    assert.equal(url, 'http://api.test/v1/models');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer api-test-key');
    assert.equal(options.headers['X-CSRF-Token'], undefined);
    assert.equal(options.headers['X-Private-Header'], undefined);
});

test('keyless server requests cannot forward cached browser Basic authorization', () => {
    const { options } = routeRequest({ ...settings, apiKey: '' }, 'http://api.test/v1/models', { requestHeaders: stHeaders });
    assert.equal(options.headers.Authorization, 'Bearer');
    assert.ok(!JSON.stringify(options).includes('private-login'));
});

test('disabled native proxy gets setup guidance and never falls back to browser or retries', async () => {
    let count = 0;
    await assert.rejects(apiRequest(settings, 'generate', { prompt: 'test', fetchImpl: async () => { count++; return new Response('CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.', { status: 404 }); } }), /enableCorsProxy: true/);
    assert.equal(count, 1);
    await assert.rejects(apiRequest(settings, 'models', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /不会自动切换/);
});

test('Basic Auth and login pages are distinct from an upstream API-key failure', async () => {
    await assert.rejects(apiRequest(settings, 'models', { fetchImpl: async () => new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="SillyTavern"' } }) }), /HTTP Basic Auth/);
    await assert.rejects(apiRequest(settings, 'models', { fetchImpl: async () => new Response('<!DOCTYPE html><html>Login</html>') }), /登录状态/);
    await assert.rejects(apiRequest(settings, 'models', { fetchImpl: async () => json({ error: { message: 'Invalid upstream API key' } }, 401) }), /Invalid upstream API key/);
});

test('signed remote image URLs use server transport without sending the API key to image hosts', async () => {
    const target = 'http://images.test/picture.png?sig=a%2Fb%3D&expires=123';
    let captured;
    const image = await extractImage({ data: [{ url: target }] }, { settings, requestHeaders: stHeaders, fetchImpl: async (url, options) => { captured = { url, options }; return new Response(Buffer.from(png, 'base64')); } });
    assert.equal(image.format, 'png');
    assert.equal(decodeURIComponent(captured.url.slice('/proxy/'.length)), target);
    assert.equal(captured.options.headers.Authorization, 'Bearer');
    assert.equal(captured.options.credentials, 'same-origin');
    assert.equal(captured.options.headers['X-CSRF-Token'], 'st-csrf');
    assert.ok(!JSON.stringify(captured).includes('api-test-key'));
});

test('service routes generation and returned image through ST, then uses the local upload API', async () => {
    const requests = [];
    const context = { chatId: 'a', chat: [{ name: '角色', mes: '雨夜' }], name1: '用户', name2: '角色', getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'st-csrf' }) };
    const service = createService(() => context, async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/images/upload') return json({ path: '/user/images/test.png' });
        const target = decodeURIComponent(url.slice('/proxy/'.length));
        return target.includes('/images/generations') ? json({ data: [{ url: 'http://images.test/result.png' }] }) : new Response(Buffer.from(png, 'base64'));
    });
    const result = await service.generate(settings, -1); await service.persist(result);
    assert.equal(requests.length, 3);
    assert.ok(requests[0].url.startsWith('/proxy/')); assert.ok(requests[1].url.startsWith('/proxy/'));
    assert.equal(requests[0].options.headers.Authorization, 'Bearer api-test-key');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer');
    assert.equal(requests[2].url, '/api/images/upload'); assert.equal(requests[2].options.headers.Authorization, undefined);
});

test('invalid transport or non-http destinations are rejected before fetch', () => {
    assert.throws(() => routeRequest({ transport: 'unknown' }, 'https://a.test'), /无效/);
    for (const target of ['file:///a.png', 'https://user:pass@a.test/image']) assert.throws(() => routeRequest(settings, target), /HTTP/);
});

test('image IDs work on remote HTTP origins without crypto.randomUUID', () => {
    assert.equal(createImageId({ getRandomValues: array => array.fill(171) }), 'ab'.repeat(16));
    assert.equal(createImageId({ randomUUID: () => 'native-uuid' }), 'native-uuid');
});
