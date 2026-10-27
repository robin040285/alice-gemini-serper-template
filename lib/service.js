import { createHash } from 'node:crypto';
import { aliceResponse, fitAliceText, safeHistory } from './alice.js';

const WAITING = 'Готовлю ответ. Через несколько секунд скажите «продолжить».';
const BUSY = 'Ещё готовлю ответ на предыдущий вопрос. Скажите «продолжить», чтобы получить его, или «отмена», чтобы задать другой вопрос.';
const EXPIRED = 'Подготовка предыдущего ответа прервалась. Пожалуйста, задайте вопрос ещё раз.';
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = text => text.toLowerCase().replace(/ё/g, 'е').replace(/[.!?,:;«»"']/g, '').trim();
const isPoll = text => /^(продолжи(ть)?|ответ готов|готово|готов|проверить ответ|давай ответ|дай ответ|ответ|дальше)$/.test(normalize(text));
const isCancel = text => /^(отмена|отмени|отменить|новый разговор|начать сначала|сброс)$/.test(normalize(text));

function failure(code) {
  if (code === 'GEMINI_QUOTA') return 'У Gemini закончился доступный лимит запросов. Попробуйте позже.';
  if (code === 'GEMINI_KEY_REJECTED' || code === 'MISSING_GEMINI_KEY') return 'Не удалось подключиться к Gemini. Нужно проверить API-ключ в Vercel.';
  if (code === 'GEMINI_UNAVAILABLE') return 'Сервис Gemini сейчас недоступен. Повторная попытка тоже не удалась. Попробуйте задать вопрос позже.';
  return 'Не удалось подготовить ответ даже после ожидания. Пожалуйста, повторите вопрос позже.';
}

export function createService({ store, generate, schedule, now = Date.now,
  fastMs = 900, log = console }) {
  async function work(owner, job) {
    let result;
    try { result = { status: 'ready', answer: fitAliceText(await generate(job)) }; }
    catch (error) {
      log.warn('Background Gemini failed:', error.message);
      result = { status: 'failed', error: failure(error.message) };
    }
    try {
      await store.update(owner, state => {
        // Never resurrect a cancelled job or overwrite a newer question.
        if (state.job?.id === job.id && state.job.status === 'pending') {
          Object.assign(state.job, result);
        }
      }, now() + 4000);
    } catch {
      log.warn('Background answer could not be saved');
    }
  }

  return async function handle(body) {
    const started = now();
    const session = body?.session || {};
    const skill = String(session.skill_id || '');
    const identity = session.user?.user_id || session.application?.application_id || session.user_id || session.session_id;
    if (!skill || !identity || !session.session_id || !Number.isInteger(session.message_id)) {
      return aliceResponse('Не удалось определить разговор. Перезапустите навык.');
    }
    const owner = hash(`${skill}:${identity}`);
    const requestId = hash(`${session.session_id}:${session.message_id}`);
    // Launch phrases should greet the user, never be sent as a question.
    const text = String(body?.request?.command || (session.new ? '' : body?.request?.original_utterance) || '').trim();
    if (text.length > 2000) return aliceResponse('Вопрос слишком длинный. Разделите его на несколько вопросов.');
    const poll = isPoll(text);
    const cancel = isCancel(text);
    let launch;

    function step(state, collect = false) {
      state.history = safeHistory(state.history);
      state.replies = Array.isArray(state.replies) ? state.replies : [];
      const cached = state.replies.find(x => x.id === requestId);
      if (cached && !collect) return { reply: aliceResponse(cached.text, false, state.history) };
      let answer;
      let job;
      if (cancel) {
        delete state.job;
        state.history = [];
        state.replies = [];
        answer = 'Задача отменена, история очищена. Какой у вас новый вопрос?';
      } else if (state.job?.status === 'pending' && now() - state.job.startedAt > 75000) {
        delete state.job;
        answer = EXPIRED;
      } else if (collect || poll || !text) {
        const current = state.job;
        if (current?.status === 'ready') {
          answer = current.answer;
          state.history = safeHistory([
            ...current.history,
            { role: 'user', text: current.question },
            { role: 'model', text: answer }
          ]);
          delete state.job;
        } else if (current?.status === 'failed') {
          answer = current.error;
          delete state.job;
        } else if (current) {
          answer = WAITING;
        } else {
          answer = poll ? 'Сейчас нет ожидающего ответа. Задайте вопрос.'
            : 'Привет! Задайте вопрос. Если ответ займёт время, я попрошу сказать «продолжить». Чтобы очистить разговор, скажите «начать сначала».';
        }
      } else if (state.job) {
        answer = state.job.status === 'pending' ? BUSY
          : 'У меня есть результат предыдущего вопроса. Скажите «продолжить», чтобы услышать его, или «отмена», чтобы начать заново.';
      } else {
        job = { id: requestId, status: 'pending', startedAt: now(), question: text, history: state.history };
        state.job = job;
        answer = WAITING;
      }
      state.replies = [...state.replies.filter(x => x.id !== requestId), { id: requestId, text: answer }].slice(-6);
      return { job, reply: aliceResponse(answer, false, state.history) };
    }

    try {
      const outcome = await store.update(owner, state => step(state), started + 2300);
      launch = outcome.job;
      if (!launch) return outcome.reply;
      const promise = work(owner, launch);
      schedule(promise);
      // Short answers can still arrive immediately. The same task keeps running
      // after this window; it is not aborted when Alice receives WAITING.
      const waitMs = Math.max(0, Math.min(fastMs, started + 2500 - now()));
      let timer;
      const done = await Promise.race([
        promise.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), waitMs); })
      ]).finally(() => clearTimeout(timer));
      if (done && now() < started + 2500) {
        try {
          const collected = await store.update(owner, state => step(state, true), started + 3300);
          return collected.reply;
        } catch { /* The answer remains in Redis for the next poll. */ }
      }
      return outcome.reply;
    } catch {
      // A timed-out Redis write might still have committed. Do not start a
      // second job until its stored status can be read on the next request.
      return aliceResponse('Хранилище ответов сейчас недоступно. Через несколько секунд скажите «продолжить».');
    }
  };
}

export { isPoll, isCancel, failure };
