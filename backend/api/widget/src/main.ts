import { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { metadataSchema, presentationSchema, ticketSchema, toolErrorSchema, widgetStateSchema, type Presentation } from './presentation';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error(`Missing widget element: ${id}`);
  return result;
}
const title = element('title', HTMLHeadingElement);
const status = element('status', HTMLSpanElement);
const statePanel = element('state', HTMLElement);
const goal = element('goal', HTMLParagraphElement);
const question = element('question', HTMLParagraphElement);
const summary = element('summary', HTMLParagraphElement);
const viewer = element('viewer', HTMLIFrameElement);
const cabinet = element('cabinet', HTMLButtonElement);
const showBrowser = element('show-browser', HTMLButtonElement);
const refreshButton = element('refresh', HTMLButtonElement);
const app = new App({ name: 'Helm Glass', version: '1.0.0' }, {});
const viewerId = crypto.randomUUID();
let current: Presentation | undefined;
let metadata: z.infer<typeof metadataSchema> | undefined;
let events: EventSource | undefined;
let streamUrl: string | undefined;
let streamCursor = '';
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let reconnects = 0;
let refreshing = false;
let dirty = false;
let browserId: string | undefined;
let browserRetry: ReturnType<typeof setTimeout> | undefined;
let browserAttempts = 0;
let openingBrowser = false;
let continuing = false;
let tornDown = false;
let superseded = false;
const supersededMessage = 'В этом чате открыт более новый виджет. Используйте его или откройте задачу в кабинете.';
const labels: Record<string, string> = { DRAFT: 'Черновик', WAITING_CHATGPT: 'Ожидает ChatGPT',
  WAITING_USER: 'Нужно участие', WAITING_BROWSER: 'Ожидает браузер', WAITING_CONNECTION: 'Ожидает подключение',
  QUEUED: 'В очереди', STARTING: 'Открывается браузер', RUNNING: 'Выполняется', PAUSING: 'Пауза запрошена', PAUSED: 'На паузе',
  STOPPING: 'Останавливается', STOPPED: 'Остановлена', SUCCEEDED: 'Выполнена', PARTIAL: 'Частичный результат',
  NOT_ACHIEVED: 'Цель не достигнута', FAILED: 'Ошибка' };

function notice(message: string, error = false): void {
  if (superseded) { message = supersededMessage; error = false; }
  statePanel.hidden = !message;
  statePanel.textContent = message;
  statePanel.className = `panel ${error ? 'error' : 'notice'}`;
}
function args(): { taskId: string; generation: string } {
  if (!current) throw new Error('Задача ещё не получена');
  if (superseded) throw new Error(supersededMessage);
  return { taskId: current.task.id, generation: current.generation };
}
function retirePresentation(): void {
  superseded = true;
  events?.close();
  events = undefined;
  clearTimeout(retryTimer);
  dirty = false;
  closeViewer();
  refreshButton.disabled = true;
  showBrowser.disabled = true;
  status.textContent = 'Неактуальный виджет';
  notice(supersededMessage);
}
async function tool(name: string, extra: Record<string, unknown> = {}) {
  const binding = { ...args(), ...extra };
  const result = await app.callServerTool({ name, arguments: binding });
  if (result.isError) {
    const text = result.content.find(item => item.type === 'text');
    let failure = toolErrorSchema.safeParse(result.structuredContent);
    if (!failure.success && text?.type === 'text') {
      try { failure = toolErrorSchema.safeParse(JSON.parse(text.text)); } catch { /* Non-JSON errors keep their plain message. */ }
    }
    if (failure.success && failure.data.code === 'STALE_WIDGET'
        && current?.task.id === binding.taskId && current.generation === binding.generation) retirePresentation();
    const message = text?.type === 'text' ? text.text : 'Сервер отклонил запрос';
    throw new Error(failure.success ? failure.data.message : message);
  }
  return result;
}
function render(next: Presentation): void {
  if (superseded) return;
  if (current && next.generation === current.generation && next.task.version < current.task.version) return;
  current = next;
  title.textContent = next.task.title;
  status.textContent = labels[next.task.status] ?? next.task.status;
  goal.textContent = next.task.goal;
  element('instruction', HTMLElement).hidden = false;
  question.textContent = next.task.request?.prompt ?? '';
  element('request', HTMLElement).hidden = !next.task.request;
  summary.textContent = [next.task.result?.summary, ...(next.task.result?.limitations ?? [])].filter(Boolean).join('\n\n');
  element('result', HTMLElement).hidden = !summary.textContent;
  cabinet.disabled = !metadata;
  refreshButton.disabled = false;
  showBrowser.disabled = !next.task.browser || next.task.browser.status !== 'LIVE' || next.task.browser.privateMode;
  if (next.task.browser?.privateMode || next.task.browser?.id !== browserId && browserId) closeViewer();
  if (next.task.browser?.privateMode) notice('Защищённый вход выполняется в кабинете. Просмотр и доступ ChatGPT к браузеру временно отключены.');
  else if (next.continuationStatus === 'MESSAGE_SENT') notice('Запрос передан в исходный чат. Ожидаем следующую команду ChatGPT.');
  else if (next.continuationStatus === 'SENDING') notice('Запрос продолжения отправляется. Если ответ host потерян, продолжите задачу в этом исходном чате.');
  else if (next.continuationStatus === 'UNAVAILABLE') notice(next.continuationReason ?? 'Host не разрешил автоматическое продолжение. Продолжите в этом чате.');
  else notice('');
  void continueTask();
}
async function refresh(): Promise<void> {
  if (superseded || tornDown) return;
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  let generation = current?.generation;
  try {
    do {
      dirty = false;
      generation = current?.generation;
      const response = await tool('widget.state');
      const next = widgetStateSchema.parse(response.structuredContent);
      if (current?.generation === generation) {
        if ('code' in next) retirePresentation();
        else render(next);
      }
    } while (dirty && !tornDown && !superseded);
  } catch (error) {
    if (current?.generation === generation) notice(error instanceof Error ? error.message : 'Не удалось обновить задачу', true);
  }
  finally {
    refreshing = false;
    if (dirty && !tornDown && !superseded) void refresh();
  }
}
function connectEvents(): void {
  if (!metadata || tornDown || superseded) return;
  clearTimeout(retryTimer);
  events?.close();
  const url = new URL(metadata.eventsUrl);
  if (streamCursor) url.searchParams.set('cursor', streamCursor);
  const source = new EventSource(url);
  events = source;
  source.onopen = () => { if (events === source) { reconnects = 0; void refresh(); } };
  source.addEventListener('change', event => {
    if (events !== source || !(event instanceof MessageEvent)) return;
    streamCursor = event.lastEventId;
    void refresh();
  });
  source.onerror = async () => {
    if (events !== source || tornDown || superseded) return;
    source.close();
    notice('Связь прервана. Восстанавливаем актуальность задачи…');
    // EventSource hides HTTP status; the authenticated state tool distinguishes a
    // superseded generation from a recoverable transport failure.
    await refresh();
    if (events !== source || tornDown || superseded) return;
    if (++reconnects > 8) { notice('Не удалось восстановить связь. Нажмите «Обновить» или откройте исходный чат.', true); return; }
    retryTimer = setTimeout(connectEvents, Math.min(30000, 500 * 2 ** reconnects) + Math.random() * 500);
  };
}
async function continueTask(): Promise<void> {
  if (!current || !current.continuationId || superseded || continuing || current.continuationStatus !== 'PENDING' || current.task.status !== 'WAITING_CHATGPT'
      || current.task.request || current.task.browser?.privateMode) return;
  const pending = current;
  const binding = { taskId: pending.task.id, generation: pending.generation, continuationId: pending.continuationId };
  const stillWaiting = () => !tornDown && !superseded && current?.generation === binding.generation
    && current.continuationId === binding.continuationId
    && current.task.id === binding.taskId && current.task.instructionRevision === pending.task.instructionRevision
    && current.task.status === 'WAITING_CHATGPT' && !current.task.request && !current.task.browser?.privateMode;
  continuing = true;
  try {
    const claimed = await tool('widget.claim', binding);
    if (!stillWaiting()) return;
    const claimContent = claimed.content.find(item => item.type === 'text');
    const claim = z.object({ claimed: z.boolean() }).parse(claimContent?.type === 'text' ? JSON.parse(claimContent.text) : null);
    if (!claim.claimed) { await refresh(); return; }
    const response = await app.sendMessage({ role: 'user', content: [{ type: 'text',
      text: `Продолжи исходную задачу Helm Glass ${pending.task.id}. Сначала получи актуальное поручение через tasks.get; ревизия ${pending.task.instructionRevision}. Не повторяй уже отправленные операции.` }] });
    if (!stillWaiting()) return;
    const sent = !response.isError;
    const reported = await tool('widget.continuation', { ...binding, sent,
      reason: sent ? '' : 'ChatGPT отклонил автоматическое сообщение. Продолжите задачу в этом исходном чате.' });
    if (stillWaiting()) render(presentationSchema.parse(reported.structuredContent));
  } catch {
    if (!stillWaiting()) return;
    const reason = 'ChatGPT не подтвердил отправку сообщения. Продолжите задачу в этом исходном чате.';
    notice(reason);
    try { await tool('widget.continuation', { ...binding, sent: false, reason }); } catch { /* The next state refresh retains server truth. */ }
  } finally {
    continuing = false;
    if (!tornDown && current !== pending) void continueTask();
  }
}
function closeViewer(): void {
  clearTimeout(browserRetry);
  browserAttempts = 0;
  viewer.removeAttribute('src');
  browserId = undefined;
  element('browser', HTMLElement).hidden = true;
}
async function openViewer(renew = false): Promise<void> {
  if (!current?.task.browser || !metadata || openingBrowser || superseded || current.task.browser.privateMode) return;
  const generation = current.generation;
  const requestedBrowser = current.task.browser.id;
  openingBrowser = true;
  try {
    const result = await tool('widget.browser', { viewerId });
    const content = result.content.find(item => item.type === 'text');
    const ticket = ticketSchema.parse(content?.type === 'text' ? JSON.parse(content.text) : null);
    if (superseded || tornDown || current.generation !== generation || current.task.browser?.id !== requestedBrowser
        || current.task.browser.privateMode) return;
    const url = new URL(ticket.url, metadata.publicUrl);
    url.searchParams.set('parentOrigin', location.origin);
    if (url.origin !== new URL(metadata.publicUrl).origin) throw new Error('Недопустимый адрес просмотра');
    if (renew && browserId === current.task.browser.id) viewer.contentWindow?.postMessage({ type: 'helm-viewer-reconnect', url: url.href }, url.origin);
    else { viewer.src = url.href; browserId = current.task.browser.id; element('browser', HTMLElement).hidden = false; }
  } catch (error) {
    if (current?.generation === generation) notice(error instanceof Error ? error.message : 'Встроенный просмотр недоступен. Откройте ту же задачу в кабинете.', true);
  }
  finally { openingBrowser = false; }
}
app.ontoolresult = response => {
  const next = presentationSchema.safeParse(response.structuredContent);
  if (!next.success) { notice('Host не передал данные задачи. Откройте её через tasks.view.', true); return; }
  if (superseded && current?.generation === next.data.generation) return;
  superseded = false;
  const meta = metadataSchema.safeParse(response._meta);
  if (meta.success) metadata = meta.data;
  render(next.data);
  if (metadata && streamUrl !== metadata.eventsUrl) {
    streamUrl = metadata.eventsUrl; streamCursor = ''; reconnects = 0; connectEvents();
  }
};
app.onteardown = async () => {
  tornDown = true; events?.close(); clearTimeout(retryTimer); closeViewer(); return {};
};
cabinet.addEventListener('click', () => { if (metadata) void app.openLink({ url: metadata.taskUrl }); });
showBrowser.addEventListener('click', () => { browserAttempts = 0; void openViewer(); });
refreshButton.addEventListener('click', () => { reconnects = 0; connectEvents(); void refresh(); });
window.addEventListener('message', event => {
  if (metadata && event.source === viewer.contentWindow && event.origin === new URL(metadata.publicUrl).origin
      && typeof event.data === 'object' && event.data !== null && Reflect.get(event.data, 'type') === 'helm-viewer'
      && Reflect.get(event.data, 'state') === 'connected') {
    browserAttempts = 0;
    clearTimeout(browserRetry);
  } else if (metadata && event.source === viewer.contentWindow
      && event.origin === new URL(metadata.publicUrl).origin && typeof event.data === 'object'
      && event.data !== null && Reflect.get(event.data, 'type') === 'helm-viewer'
      && ['disconnected', 'error'].includes(String(Reflect.get(event.data, 'state'))) && browserId) {
    clearTimeout(browserRetry);
    if (++browserAttempts > 8) { notice('Просмотр недоступен. Нажмите «Показать браузер» для новой попытки.'); return; }
    browserRetry = setTimeout(() => { void openViewer(true); },
      Math.min(30000, 500 * 2 ** browserAttempts) + Math.random() * 500);
  }
});
try { await app.connect(); }
catch { notice('Этот host не поддерживает интерактивный виджет. Откройте задачу по ссылке Helm Glass в ответе инструмента.', true); }
