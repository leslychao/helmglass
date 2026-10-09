import { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { stepsSchema, metadataSchema, presentationSchema, ticketSchema, toolErrorSchema, widgetStateSchema, type Presentation } from './presentation';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error('Missing widget element: ' + id);
  return result;
}

const title = element('title', HTMLHeadingElement);
const status = element('header-status', HTMLSpanElement);
const statePanel = element('state', HTMLElement);
const address = element('address', HTMLSpanElement);
const browserState = element('browser-state', HTMLParagraphElement);
const viewer = element('viewer', HTMLIFrameElement);
const cabinet = element('cabinet', HTMLButtonElement);
const brand = element('brand', HTMLImageElement);
const historyStatus = element('history-state', HTMLParagraphElement);
const steps = element('steps', HTMLOListElement);
const stepsToggle = element('steps-toggle', HTMLButtonElement);
const stepsPanel = element('steps-panel', HTMLElement);
const viewport = element('viewport', HTMLElement);
const app = new App({ name: 'Helm Glass', version: '1.0.0' }, {});
const viewerId = crypto.randomUUID();
const retryLimit = 8;
let current: Presentation | undefined;
let metadata: z.infer<typeof metadataSchema> | undefined;
let validated = false;
let syncReady = false;
let historyDirty = true;
let historyLoading = false;
let historyGeneration = 0;
let viewerGeneration = 0;
let events: EventSource | undefined;
let streamUrl: string | undefined;
let streamCursor = '';
let streamConnected = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let reconnects = 0;
let connectionError = '';
let refreshing = false;
let dirty = false;
let browserId: string | undefined;
let browserConnected = false;
let browserRetry: ReturnType<typeof setTimeout> | undefined;
let browserAttempts = 0;
let browserError = '';
let openingBrowser = false;
let continuing = false;
let tornDown = false;
let superseded = false;
let online = navigator.onLine;
const supersededMessage = 'Неактивная карточка. Актуальный виджет находится в более новом ответе этого чата.';
const finishedStatuses = new Set(['SUCCEEDED', 'PARTIAL', 'NOT_ACHIEVED', 'FAILED', 'STOPPED']);
const labels: Record<string, string> = {
  DRAFT: 'Черновик', WAITING_CHATGPT: 'Ожидает ChatGPT', WAITING_USER: 'Нужно участие',
  WAITING_BROWSER: 'Ожидает браузер', WAITING_CONNECTION: 'Ожидает подключение',
  QUEUED: 'В очереди', STARTING: 'Открывается браузер', RUNNING: 'Выполняется',
  PAUSING: 'Пауза запрошена', PAUSED: 'На паузе', STOPPING: 'Останавливается',
  STOPPED: 'Остановлена', SUCCEEDED: 'Выполнена', PARTIAL: 'Частичный результат',
  NOT_ACHIEVED: 'Цель не достигнута', FAILED: 'Ошибка', UNKNOWN: 'Исход неизвестен',
};
const stepLabels: Record<z.infer<typeof stepsSchema>['items'][number]['status'], string> = {
  PLANNED: 'Запланирован', RUNNING: 'Выполняется', WAITING: 'Ожидает', SUCCEEDED: 'Выполнен',
  PARTIAL: 'Частично выполнен', FAILED: 'Не выполнен', UNKNOWN: 'Результат неизвестен', SKIPPED: 'Пропущен',
};
const stepRows = new Map<string, { row: HTMLLIElement; heading: HTMLElement; details: HTMLElement;
  description: HTMLParagraphElement; version: number }>();
const browserWaiting: Record<string, string> = {
  DRAFT: 'Браузер откроется после запуска задачи.',
  QUEUED: 'Ожидаем свободного места для браузера.',
  WAITING_BROWSER: 'Ожидаем свободного места для браузера.',
  WAITING_CONNECTION: 'Ожидаем выбранное подключение.',
  STARTING: 'Браузер подготавливается…',
  STOPPING: 'Задача останавливается…',
};

function notice(message: string, error = false): void {
  if (superseded) { message = supersededMessage; error = false; }
  statePanel.hidden = !message;
  statePanel.textContent = message;
  statePanel.className = error ? 'error' : '';
}

function needsLogin(): boolean {
  return current?.task.waitReason === 'LOGIN' || current?.task.request?.type === 'LOGIN'
    || current?.task.browser?.privateMode === true;
}

function renderNotice(): void {
  if (connectionError) notice(connectionError, true);
  else if (current?.continuationStatus === 'MESSAGE_SENT') {
    notice('Запрос передан в исходный чат. Ожидаем следующую команду ChatGPT.');
  } else if (current?.continuationStatus === 'SENDING') {
    notice('Ожидаем подтверждения отправки запроса продолжения в исходный чат.');
  } else if (current?.continuationStatus === 'UNAVAILABLE') {
    notice(current.continuationReason ?? 'Автоматическое продолжение недоступно. Продолжите задачу в этом чате.');
  } else if (current?.continuationStatus === 'PENDING' && !app.getHostCapabilities()?.message?.text) {
    notice('Этот чат не поддерживает автоматическое продолжение. Напишите в нём, чтобы продолжить задачу.');
  } else notice('');
}

function renderBrowser(): void {
  const browser = current?.task.browser;
  if (finishedStatuses.has(current?.task.status ?? '') || browser?.status === 'CLOSED') {
    viewer.hidden = true;
    browserState.hidden = true;
    browserState.textContent = '';
    return;
  }
  viewer.hidden = !browserConnected || !syncReady || !browser || browser.privateMode || browser.status !== 'LIVE';
  browserState.hidden = !viewer.hidden;
  browserState.textContent = browser?.privateMode ? 'Защищённый вход открыт в Helm Glass.'
    : !syncReady ? 'Восстанавливаем актуальное состояние браузера…'
    : browserError || (browser?.status === 'LIVE' ? 'Подключаем просмотр браузера…'
      : browser?.status === 'LOST' ? 'Браузер утрачен. Для продолжения требуется восстановление.'
      : browser?.status === 'UNREACHABLE' ? 'Связь с браузером потеряна. Ожидаем восстановления.'
      : browser?.status === 'CLOSING' ? 'Ожидаем закрытия браузера…'
      : browser ? 'Браузер подготавливается…'
      : browserWaiting[current?.task.status ?? ''] ?? 'Браузер подготавливается…');
}

function args(): { taskId: string; generation: string } {
  if (!current) throw new Error('Задача ещё не получена');
  if (superseded) throw new Error(supersededMessage);
  return { taskId: current.task.id, generation: current.generation };
}

function retirePresentation(): void {
  superseded = true;
  validated = false;
  syncReady = false;
  historyGeneration++;
  element('card', HTMLElement).classList.add('superseded');
  element('content', HTMLElement).inert = true;
  cabinet.disabled = true;
  events?.close();
  events = undefined;
  clearTimeout(retryTimer);
  dirty = false;
  closeViewer();
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
      try { failure = toolErrorSchema.safeParse(JSON.parse(text.text)); } catch { /* Plain errors remain plain. */ }
    }
    if (failure.success && failure.data.code === 'STALE_WIDGET'
        && current?.task.id === binding.taskId && current.generation === binding.generation) retirePresentation();
    throw new Error(failure.success ? failure.data.message : 'Сервер отклонил запрос.');
  }
  return result;
}

function render(next: Presentation): void {
  if (superseded || tornDown || !validated) return;
  if (current?.generation === next.generation) {
    if (next.task.version < current.task.version) return;
    const previousBrowser = current.task.browser;
    if (previousBrowser && next.task.browser?.id === previousBrowser.id
        && next.task.browser.version < previousBrowser.version) {
      next = { ...next, task: { ...next.task, browser: previousBrowser } };
    }
  }
  current = next;
  title.textContent = next.task.title;
  status.textContent = labels[next.task.status] ?? next.task.status;
  status.setAttribute('data-status', next.task.status);
  element('summary', HTMLSpanElement).textContent = next.task.summary ?? '';
  const finished = finishedStatuses.has(next.task.status);
  element('content', HTMLElement).inert = finished;
  cabinet.disabled = finished || !metadata;
  stepsToggle.disabled = finished;
  cabinet.textContent = needsLogin() ? 'Войти на сайт' : 'Открыть в Helm Glass';
  const browser = next.task.browser;
  address.textContent = browser?.privateMode ? 'Защищённый вход' : 'Браузер подготавливается';
  if (browser?.currentUrl && !browser.privateMode) {
    try {
      const url = new URL(browser.currentUrl);
      address.textContent = ['https:', 'http:'].includes(url.protocol) ? url.origin + url.pathname : 'Новая вкладка';
    } catch { address.textContent = 'Адрес недоступен'; }
  }
  if (finished || !browser || browser.status !== 'LIVE' || browser.privateMode || browserId && browser.id !== browserId) closeViewer();
  renderBrowser();
  if (!finished && syncReady && browser?.status === 'LIVE' && !browserId && !browserRetry && browserAttempts <= retryLimit) void openViewer();
  if (historyDirty) void loadHistory();
  renderNotice();
  void continueTask();
}

function scheduleReconnect(): void {
  if (retryTimer || tornDown || superseded || !online) return;
  if (++reconnects > retryLimit) {
    connectionError = 'Связь недоступна. При возвращении в чат или восстановлении сети проверка возобновится.';
    renderNotice();
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void refresh();
  }, Math.min(30000, 500 * 2 ** reconnects) + Math.random() * 500);
}

async function refresh(): Promise<void> {
  if (superseded || tornDown || !online) return;
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  let generation = current?.generation;
  try {
    do {
      dirty = false;
      generation = current?.generation;
      const response = await tool('widget.state');
      const next = widgetStateSchema.parse(response.structuredContent);
      if (current?.generation !== generation || tornDown || superseded || !online) continue;
      if ('code' in next) retirePresentation();
      else {
        validated = true;
        syncReady = streamConnected;
        if (syncReady) connectionError = '';
        render(next);
        if (!events && metadata && !retryTimer && reconnects <= retryLimit) connectEvents();
      }
    } while (dirty && !tornDown && !superseded && online);
  } catch {
    if (current?.generation === generation && !superseded && !tornDown && online) {
      syncReady = false;
      connectionError = 'Не удалось получить актуальное состояние задачи. Восстанавливаем связь…';
      renderBrowser();
      renderNotice();
      scheduleReconnect();
    }
  } finally {
    refreshing = false;
    if (dirty && !tornDown && !superseded && online) void refresh();
  }
}

function connectEvents(): void {
  if (!metadata || !validated || tornDown || superseded || !online) return;
  events?.close();
  const url = new URL(metadata.eventsUrl);
  if (streamCursor) url.searchParams.set('cursor', streamCursor);
  const source = new EventSource(url);
  events = source;
  source.onopen = () => {
    if (events !== source) return;
    streamConnected = true;
    reconnects = 0;
    historyDirty = true;
    void refresh();
  };
  source.addEventListener('change', event => {
    if (events !== source || !(event instanceof MessageEvent)) return;
    streamCursor = event.lastEventId;
    let resource = '';
    try { resource = z.object({ resource: z.string() }).parse(JSON.parse(String(event.data))).resource; }
    catch { /* An unreadable event requires a fresh authoritative snapshot. */ }
    if (resource === 'step' || resource === 'sync' || !resource) {
      historyDirty = true;
      void loadHistory();
    }
    if (resource !== 'step') void refresh();
  });
  source.onerror = () => {
    if (events !== source || tornDown || superseded) return;
    source.close();
    events = undefined;
    streamConnected = false;
    syncReady = false;
    connectionError = 'Связь прервана. Восстанавливаем актуальность задачи…';
    renderBrowser();
    renderNotice();
    scheduleReconnect();
  };
}

async function continueTask(): Promise<void> {
  if (!validated || !syncReady || tornDown || !current?.continuationId || superseded || continuing
      || current.continuationStatus !== 'PENDING' || current.task.status !== 'WAITING_CHATGPT'
      || current.task.request || current.task.browser?.privateMode || !app.getHostCapabilities()?.message?.text) return;
  const pending = current;
  const binding = { taskId: pending.task.id, generation: pending.generation, continuationId: pending.continuationId };
  const stillWaiting = () => !tornDown && !superseded && online && syncReady && current?.generation === binding.generation
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
      text: 'Продолжи исходную задачу Helm Glass ' + pending.task.id
        + '. Сначала получи актуальное поручение через tasks.get; ревизия ' + pending.task.instructionRevision
        + '. Покажи одну новую карточку через tasks.view в этом ответе и продолжай автономно. Не повторяй уже отправленные операции.' }] });
    if (!stillWaiting()) return;
    const sent = !response.isError;
    const reported = await tool('widget.continuation', { ...binding, sent,
      reason: sent ? '' : 'ChatGPT отклонил автоматическое сообщение. Продолжите задачу в этом исходном чате.' });
    if (stillWaiting()) render(presentationSchema.parse(reported.structuredContent));
  } catch {
    if (!stillWaiting()) return;
    const reason = 'ChatGPT не подтвердил отправку сообщения. Продолжите задачу в этом исходном чате.';
    notice(reason);
    try { await tool('widget.continuation', { ...binding, sent: false, reason }); } catch { /* Keep server truth after an unknown send. */ }
  } finally {
    continuing = false;
    if (!tornDown && current !== pending) void continueTask();
  }
}

function closeViewer(): void {
  viewerGeneration++;
  clearTimeout(browserRetry);
  browserRetry = undefined;
  browserAttempts = 0;
  browserError = '';
  browserConnected = false;
  viewer.removeAttribute('src');
  viewer.hidden = true;
  browserId = undefined;
}

function retryViewer(): void {
  browserConnected = false;
  browserError = 'Связь с браузером прервана. Восстанавливаем просмотр…';
  renderBrowser();
  if (browserRetry || tornDown || superseded || !online) return;
  if (++browserAttempts > retryLimit) {
    browserError = 'Просмотр временно недоступен. При возвращении в чат или восстановлении сети подключимся снова.';
    renderBrowser();
    return;
  }
  browserRetry = setTimeout(() => {
    browserRetry = undefined;
    void openViewer(true);
  }, Math.min(30000, 500 * 2 ** browserAttempts) + Math.random() * 500);
}

async function openViewer(renew = false): Promise<void> {
  if (!validated || !syncReady || !online || !current?.task.browser || !metadata || openingBrowser
      || finishedStatuses.has(current.task.status)
      || superseded || tornDown || current.task.browser.status !== 'LIVE'
      || current.task.browser.privateMode || browserId && !renew) return;
  const attempt = viewerGeneration;
  const generation = current.generation;
  const requestedBrowser = current.task.browser.id;
  openingBrowser = true;
  try {
    const result = await tool('widget.browser', { viewerId });
    const content = result.content.find(item => item.type === 'text');
    const ticket = ticketSchema.parse(content?.type === 'text' ? JSON.parse(content.text) : null);
    if (attempt !== viewerGeneration || superseded || tornDown || current.generation !== generation
        || current.task.browser?.id !== requestedBrowser || current.task.browser.privateMode) return;
    const url = new URL(ticket.url, metadata.publicUrl);
    if (url.origin !== new URL(metadata.publicUrl).origin || url.username || url.password) throw new Error('Invalid viewer origin');
    url.searchParams.set('parentOrigin', location.origin);
    url.searchParams.set('view_only', '1');
    url.searchParams.set('viewerEpoch', String(attempt));
    browserConnected = false;
    if (renew && browserId === requestedBrowser) {
      viewer.contentWindow?.postMessage({ type: 'helm-viewer-reconnect', url: url.href }, url.origin);
    } else {
      viewer.src = url.href;
      browserId = requestedBrowser;
    }
    renderBrowser();
    clearTimeout(browserRetry);
    browserRetry = setTimeout(() => {
      browserRetry = undefined;
      if (attempt === viewerGeneration && !browserConnected) retryViewer();
    }, 10000);
  } catch {
    if (current?.generation === generation && attempt === viewerGeneration && !superseded && !tornDown) retryViewer();
  } finally {
    openingBrowser = false;
    if (attempt !== viewerGeneration && !browserId && !browserRetry) void openViewer();
  }
}

async function loadHistory(): Promise<void> {
  if (!validated || superseded || tornDown || !online || !current || historyLoading) return;
  historyLoading = true;
  const request = historyGeneration;
  const generation = current.generation;
  try {
    do {
      historyDirty = false;
      const response = await tool('widget.steps', { page: 1 });
      const content = response.content.find(item => item.type === 'text');
      const history = stepsSchema.parse(content?.type === 'text' ? JSON.parse(content.text) : null);
      if (superseded || tornDown || current.generation !== generation || request !== historyGeneration) return;
      if (historyDirty) continue;
      const visible = new Set(history.items.map(entry => entry.id));
      for (const [id, view] of stepRows) {
        if (!visible.has(id)) { view.row.remove(); stepRows.delete(id); }
      }
      for (const [index, entry] of history.items.entries()) {
        let view = stepRows.get(entry.id);
        if (!view) {
          const row = document.createElement('li');
          const heading = document.createElement('strong');
          const details = document.createElement('small');
          const description = document.createElement('p');
          row.append(details, heading, description);
          view = { row, heading, details, description, version: 0 };
          stepRows.set(entry.id, view);
        }
        if (entry.version >= view.version) {
          view.heading.textContent = entry.title;
          const created = new Date(entry.createdAt);
          view.details.textContent = stepLabels[entry.status] + ' · '
            + created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          view.details.title = created.toLocaleString('ru-RU');
          view.description.textContent = entry.result ?? '';
          view.description.hidden = !entry.result;
          view.version = entry.version;
        }
        if (steps.children[index] !== view.row) steps.insertBefore(view.row, steps.children[index] ?? null);
      }
      element('steps-count', HTMLSpanElement).textContent = 'Шаги: ' + history.total;
      element('event-count', HTMLSpanElement).textContent = 'Всего шагов: ' + history.total;
      historyStatus.textContent = history.total === 0 ? 'Бизнес-шаги для этой задачи не записаны.' : '';
      historyStatus.hidden = history.total !== 0;
    } while (historyDirty && !superseded && !tornDown);
  } catch {
    if (!superseded && !tornDown && request === historyGeneration) {
      historyStatus.hidden = false;
      historyStatus.textContent = 'Не удалось обновить шаги. Показаны последние полученные шаги.';
    }
  } finally {
    historyLoading = false;
    if (historyDirty && online && !superseded && !tornDown) void loadHistory();
  }
}

app.ontoolresult = response => {
  if (superseded || tornDown) return;
  const next = presentationSchema.safeParse(response.structuredContent);
  if (!next.success) { notice('Чат не передал данные задачи. Откройте её через tasks.view.', true); return; }
  const changed = current?.generation !== next.data.generation;
  if (changed) {
    validated = false;
    syncReady = false;
    streamConnected = false;
    events?.close();
    events = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    closeViewer();
    historyGeneration++;
    historyDirty = true;
    steps.replaceChildren();
    element('event-count', HTMLSpanElement).textContent = '';
    element('steps-count', HTMLSpanElement).textContent = '';
    historyStatus.hidden = false;
    historyStatus.textContent = 'Получаем шаги…';
    cabinet.disabled = true;
    metadata = undefined;
    current = next.data;
  }
  title.textContent = next.data.task.title;
  const meta = metadataSchema.safeParse(response._meta);
  if (meta.success && [meta.data.taskUrl, meta.data.loginUrl].every(value => new URL(value).pathname === '/tasks/' + next.data.task.id)) {
    metadata = meta.data;
    brand.src = new URL('/helm-logo.png', metadata.publicUrl).href;
    if (streamUrl !== metadata.eventsUrl) {
      streamUrl = metadata.eventsUrl;
      streamCursor = '';
      reconnects = 0;
    }
  } else {
    notice('Не удалось проверить ссылку на задачу.', true);
    return;
  }
  void refresh();
};

function recover(): void {
  online = navigator.onLine;
  if (!online) return;
  if (tornDown || superseded || !current || document.visibilityState === 'hidden') return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  reconnects = 0;
  browserAttempts = 0;
  clearTimeout(browserRetry);
  browserRetry = undefined;
  if (browserId && !browserConnected) closeViewer();
  historyDirty = true;
  void refresh();
}

function offline(): void {
  online = false;
  if (tornDown || superseded) return;
  syncReady = false;
  streamConnected = false;
  events?.close();
  events = undefined;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  dirty = false;
  historyGeneration++;
  historyDirty = true;
  closeViewer();
  connectionError = 'Нет сети. Последний кадр скрыт; просмотр восстановится после подключения.';
  renderBrowser();
  renderNotice();
}

app.onteardown = async () => {
  tornDown = true;
  historyGeneration++;
  events?.close();
  clearTimeout(retryTimer);
  closeViewer();
  window.removeEventListener('online', recover);
  window.removeEventListener('offline', offline);
  document.removeEventListener('visibilitychange', recover);
  return {};
};

cabinet.addEventListener('click', () => {
  if (metadata && validated && !superseded && !finishedStatuses.has(current?.task.status ?? '')) {
    void app.openLink({ url: needsLogin() ? metadata.loginUrl : metadata.taskUrl })
      .then(result => { if (result.isError) notice('Не удалось открыть задачу в Helm Glass.', true); })
      .catch(() => notice('Не удалось открыть задачу в Helm Glass.', true));
  }
});

stepsToggle.addEventListener('click', () => {
  if (superseded || tornDown || finishedStatuses.has(current?.task.status ?? '')) return;
  stepsPanel.hidden = !stepsPanel.hidden;
  element('execution', HTMLElement).classList.toggle('steps-collapsed', stepsPanel.hidden);
  stepsToggle.setAttribute('aria-expanded', String(!stepsPanel.hidden));
  const label = stepsPanel.hidden ? 'Показать шаги' : 'Скрыть шаги';
  stepsToggle.setAttribute('aria-label', label);
  stepsToggle.title = label;
});

window.addEventListener('online', recover);
window.addEventListener('offline', offline);
document.addEventListener('visibilitychange', recover);
window.addEventListener('message', event => {
  if (!validated || superseded || tornDown || !online || !metadata || !browserId
      || event.source !== viewer.contentWindow || event.origin !== new URL(metadata.publicUrl).origin
      || typeof event.data !== 'object' || event.data === null || Reflect.get(event.data, 'type') !== 'helm-viewer'
      || Reflect.get(event.data, 'viewerEpoch') !== String(viewerGeneration)) return;
  const state = Reflect.get(event.data, 'state');
  const width = Reflect.get(event.data, 'width');
  const height = Reflect.get(event.data, 'height');
  if (typeof width === 'number' && Number.isInteger(width) && width > 0 && width <= 8192
      && typeof height === 'number' && Number.isInteger(height) && height > 0 && height <= 8192) {
    viewport.style.aspectRatio = width + ' / ' + height;
  }
  if (state === 'connected') {
    browserConnected = true;
    browserError = '';
    browserAttempts = 0;
    clearTimeout(browserRetry);
    browserRetry = undefined;
    renderBrowser();
  } else if (state === 'disconnected' || state === 'error') {
    clearTimeout(browserRetry);
    browserRetry = undefined;
    retryViewer();
  }
});

try { await app.connect(); }
catch { notice('Этот чат не поддерживает интерактивный виджет. Откройте задачу по ссылке Helm Glass в ответе инструмента.', true); }
