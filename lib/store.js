// A compare-and-set keeps simultaneous polls, cancellation, and workers from
// overwriting one another. Redis stores the state; process memory is not used.
const CAS = `
local current = redis.call('GET', KEYS[1])
if (not current and ARGV[1] == '') or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0`;

export function createStore({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  async function command(args, deadline) {
    const left = deadline - now();
    if (left < 30) throw new Error('STORAGE_TIMEOUT');
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(Math.min(1000, left))
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error('STORAGE_UNAVAILABLE');
      return data.result;
    } catch {
      throw new Error('STORAGE_UNAVAILABLE');
    }
  }
  return {
    configured: Boolean(url && token && /^https:\/\//.test(url)),
    async update(owner, mutate, deadline = now() + 2500) {
      if (!url || !token) throw new Error('MISSING_STORAGE');
      const key = `alice:v2:${owner}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await command(['GET', key], deadline);
        const state = raw ? JSON.parse(raw) : { history: [], replies: [] };
        const result = mutate(state);
        const encoded = JSON.stringify(state);
        if (encoded === raw) return result;
        const written = await command(['EVAL', CAS, 1, key, raw || '', encoded, 86400], deadline);
        if (written === 1) return result;
      }
      throw new Error('STORAGE_BUSY');
    }
  };
}

export { CAS };
