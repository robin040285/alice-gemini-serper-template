import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.js';
import { createGenerator } from '../lib/gemini.js';
import { createStore, CAS } from '../lib/store.js';

const quiet = { info() {}, warn() {} };
function memoryStore() {
  const values = new Map();
  return { configured: true, values, async update(owner, mutate) {
    const state = structuredClone(values.get(owner) || { history: [], replies: [] });
    const result = mutate(state);
    values.set(owner, structuredClone(state));
    return result;
  } };
}
function body(command, message = 1, user = 'user-a', session = 'conversation') {
  return { session: { skill_id: 'skill', session_id: session, message_id: message,
    user: { user_id: user }, new: false }, request: { command } };
}
function deferred() { let resolve; let reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject}; }
function setup(options = {}) {
  const store = options.store || memoryStore();
  const tasks = [];
  const service = createService({ store, generate: async () => 'Готовый ответ.',
    schedule: p => tasks.push(p), fastMs: 0, log: quiet, ...options });
  return { store, service, tasks };
}

test('slow work returns promptly; another server instance retrieves the saved answer', async () => {
  const pending = deferred();
  const a = setup({ generate: () => pending.promise });
  const start = Date.now();
  assert.match((await a.service(body('Почему небо голубое?'))).response.text, /Готовлю/);
  assert.ok(Date.now() - start < 500);
  pending.resolve('Из-за рассеяния света.');
  await Promise.all(a.tasks);
  const b = setup({ store: a.store });
  const result = await b.service(body('продолжить', 2));
  assert.equal(result.response.text, 'Из-за рассеяния света.');
  assert.deepEqual(result.session_state.history.map(x => x.role), ['user', 'model']);
  assert.equal(b.tasks.length, 0);
});

test('fast answers can be delivered immediately', async () => {
  const { service } = setup({ fastMs: 100 });
  assert.equal((await service(body('Два плюс два?'))).response.text, 'Готовый ответ.');
});

test('answer taking over three seconds remains retrievable after foreground response', async () => {
  const a = setup({ fastMs: 20, generate: async () => {
    await new Promise(resolve => setTimeout(resolve, 3100));
    return 'Долгий ответ сохранён.';
  } });
  const started = Date.now();
  assert.match((await a.service(body('Вопрос'))).response.text, /Готовлю/);
  assert.ok(Date.now() - started < 500);
  await Promise.all(a.tasks);
  assert.ok(Date.now() - started >= 3000);
  assert.equal((await a.service(body('продолжить', 2))).response.text, 'Долгий ответ сохранён.');
});

test('duplicate webhook launches exactly one generation', async () => {
  let calls = 0;
  const pending = deferred();
  const a = setup({ generate: () => { calls++; return pending.promise; } });
  const req = body('Вопрос');
  const replies = await Promise.all([a.service(req), a.service(req), a.service(req)]);
  assert.ok(replies.every(x => x.response.text.includes('Готовлю')));
  assert.equal(calls, 1);
  pending.resolve('Ответ'); await Promise.all(a.tasks);
});

test('polling never starts another generation; another question does not overwrite work', async () => {
  const pending = deferred();
  const a = setup({ generate: () => pending.promise });
  await a.service(body('Первый вопрос'));
  assert.match((await a.service(body('продолжить', 2))).response.text, /Готовлю/);
  assert.match((await a.service(body('Другой вопрос', 3))).response.text, /предыдущий/);
  assert.equal(a.tasks.length, 1);
  pending.resolve('Первый ответ'); await Promise.all(a.tasks);
  assert.match((await a.service(body('Другой вопрос', 4))).response.text, /предыдущего/);
  assert.equal((await a.service(body('продолжить', 5))).response.text, 'Первый ответ');
});

test('cancelled worker cannot overwrite the next job or restore cancelled context', async () => {
  const old = deferred(), next = deferred();
  const a = setup({ generate: j => j.question === 'Первый' ? old.promise : next.promise });
  await a.service(body('Первый'));
  await a.service(body('отмена', 2));
  await a.service(body('Второй', 3));
  old.resolve('Старый ответ'); await a.tasks[0];
  assert.match((await a.service(body('продолжить', 4))).response.text, /Готовлю/);
  next.resolve('Новый ответ'); await a.tasks[1];
  const result = await a.service(body('продолжить', 5));
  assert.equal(result.response.text, 'Новый ответ');
  assert.equal(result.session_state.history[0].text, 'Второй');
});

test('replayed delivery does not append the same history twice; follow-up uses context', async () => {
  const jobs = [];
  const a = setup({ fastMs: 100, generate: async j => { jobs.push(j); return 'Ответ'; } });
  await a.service(body('Первый вопрос'));
  const first = await a.service(body('Уточнение', 2));
  const duplicate = await a.service(body('Уточнение', 2));
  assert.equal(first.session_state.history.length, 4);
  assert.equal(duplicate.session_state.history.length, 4);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].history[0].text, 'Первый вопрос');
});

test('ready answer survives a new session and never leaks to a different user', async () => {
  const pending = deferred();
  const a = setup({ generate: () => pending.promise });
  await a.service(body('Вопрос'));
  pending.resolve('Готовый ответ.');
  await Promise.all(a.tasks);
  assert.match((await a.service(body('продолжить', 1, 'other-user'))).response.text, /нет ожидающего/);
  assert.equal((await a.service(body('продолжить', 0, 'user-a', 'new-session'))).response.text, 'Готовый ответ.');
});

test('anonymous application identity works and empty launch does not call Gemini', async () => {
  const a = setup();
  const req = body('');
  delete req.session.user;
  req.session.application = { application_id: 'anonymous-app' };
  req.session.new = true;
  req.request.original_utterance = 'Запусти навык';
  assert.match((await a.service(req)).response.text, /Привет/);
  assert.equal(a.tasks.length, 0);
});

test('stale or failed work returns an actionable message and can be replaced', async () => {
  let time = 0;
  const never = deferred();
  const a = setup({ now: () => time, generate: () => never.promise });
  await a.service(body('Вопрос'));
  time = 76000;
  assert.match((await a.service(body('продолжить', 2))).response.text, /прервалась/);
  never.resolve('Поздний ответ'); await Promise.all(a.tasks);
  assert.match((await a.service(body('продолжить', 3))).response.text, /нет ожидающего/);
  const b = setup({ fastMs: 100, generate: async () => { throw new Error('GEMINI_QUOTA'); } });
  assert.match((await b.service(body('Вопрос'))).response.text, /лимит/);
  assert.equal([...b.store.values.values()][0].history.length, 0);
});

test('storage outage and malformed session do not launch work', async () => {
  const a = setup({ store: { async update() { throw new Error('offline'); } } });
  assert.match((await a.service(body('Вопрос'))).response.text, /Хранилище/);
  assert.match((await a.service({})).response.text, /определить/);
  assert.equal(a.tasks.length, 0);
});

function upstream(status, data) { return { ok: status === 200, status, async json() { return data; } }; }
const answerData = { candidates: [{ content: { parts: [{ thought: true, text: 'secret reasoning' }, { text: 'Ответ.' }] } }] };

test('503 is retried once, thoughts filtered, and only minimal reasoning requested', async () => {
  let calls = 0, sleeps = 0;
  const generate = createGenerator({ env: { GEMINI_API_KEY: 'secret', GEMINI_MODEL: 'gemini-3.5-flash-lite' }, log: quiet,
    sleep: async () => { sleeps++; }, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel, 'minimal');
      return calls === 1 ? upstream(503, {}) : upstream(200, answerData);
    } });
  assert.equal(await generate({ question: 'Вопрос', history: [] }), 'Ответ.');
  assert.equal(calls, 2); assert.equal(sleeps, 1);
});

test('repeated 503 stops after two calls; quota and bad key are not retried', async () => {
  for (const [status, error, expected] of [[503, 'GEMINI_UNAVAILABLE', 2], [429, 'GEMINI_QUOTA', 1], [403, 'GEMINI_KEY_REJECTED', 1]]) {
    let calls = 0;
    const generate = createGenerator({ env: { GEMINI_API_KEY: 'secret' }, log: quiet,
      sleep: async () => {}, fetchImpl: async () => { calls++; return upstream(status, {}); } });
    await assert.rejects(generate({ question: 'Вопрос', history: [] }), new RegExp(error));
    assert.equal(calls, expected);
  }
});

test('search failure is explicitly disclosed to model and search is not repeated on retry', async () => {
  let searches = 0, generations = 0;
  const generate = createGenerator({ env: { GEMINI_API_KEY: 'secret', SERPER_API_KEY: 'secret-search' }, log: quiet,
    sleep: async () => {}, fetchImpl: async (url, options) => {
      if (url.includes('serper')) { searches++; return upstream(500, {}); }
      generations++;
      assert.match(JSON.parse(options.body).contents.at(-1).parts[0].text, /Поиск сейчас не сработал/);
      return generations === 1 ? upstream(503, {}) : upstream(200, answerData);
    } });
  assert.equal(await generate({ question: 'Найди новости', history: [] }), 'Ответ.');
  assert.equal(searches, 1); assert.equal(generations, 2);
});

test('REST storage uses authorization header, atomic CAS, TTL, and retries conflicts', async () => {
  let raw = null, conflict = true, writes = 0;
  const store = createStore({ env: { UPSTASH_REDIS_REST_URL: 'https://storage.test', UPSTASH_REDIS_REST_TOKEN: 'storage-secret' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://storage.test');
      assert.equal(options.headers.Authorization, 'Bearer storage-secret');
      const cmd = JSON.parse(options.body);
      if (cmd[0] === 'GET') return upstream(200, { result: raw });
      assert.equal(cmd[0], 'EVAL'); assert.equal(cmd[1], CAS);
      assert.equal(cmd[6], 86400);
      writes++;
      if (conflict) { conflict = false; raw = JSON.stringify({ history: [], replies: [], count: 1 }); return upstream(200, { result: 0 }); }
      assert.equal(cmd[4], raw); raw = cmd[5];
      return upstream(200, { result: 1 });
    } });
  assert.equal(await store.update('owner-hash', s => { s.count = (s.count || 0) + 1; return s.count; }), 2);
  assert.equal(writes, 2);
  assert.equal(JSON.parse(raw).count, 2);
});

test('REST error messages and tokens are never exposed', async () => {
  const store = createStore({ env: { UPSTASH_REDIS_REST_URL: 'https://storage.test', UPSTASH_REDIS_REST_TOKEN: 'secret' },
    fetchImpl: async () => upstream(401, { error: 'private-token-in-upstream-error' }) });
  await assert.rejects(store.update('owner', () => {}), error => error.message === 'STORAGE_UNAVAILABLE');
});
