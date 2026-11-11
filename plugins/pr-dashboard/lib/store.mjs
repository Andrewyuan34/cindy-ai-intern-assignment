// /kv replaces the complete object. Keep every writer behind this queue.
export function createStore({ fetch: request = globalThis.fetch } = {}) {
  let queue = Promise.resolve();
  async function read() {
    const response = await request('/kv');
    if (!response.ok) throw new Error('无法读取插件配置，请重试。原配置未被覆盖。');
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('插件配置格式无效，请检查配置后重试。');
    }
    return value;
  }
  function update(change) {
    const operation = queue.then(async () => {
      const draft = structuredClone(await read());
      await change(draft);
      const body = JSON.stringify(draft);
      if (new TextEncoder().encode(body).length > 60 * 1024) {
        throw new Error('任务关联记录已达到存储上限，请先处理待确认的诊断请求。此次未派发。');
      }
      const response = await request('/kv', { method: 'PUT', body });
      if (response.status !== 204) throw new Error('无法保存任务关联，请重试。此次未继续派发。');
      return structuredClone(draft);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { read: () => queue.then(read), update };
}
