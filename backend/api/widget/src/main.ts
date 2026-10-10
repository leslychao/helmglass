import { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

import { stepsSchema, metadataSchema, presentationSchema, presentationReferenceSchema, ticketSchema, toolErrorSchema, widgetStateSchema, type Presentation } from './presentation';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error('Missing widget element: ' + id);
  return result;
}

const title = element('title', HTMLHeadingElement);
const status = element('header-status', HTMLSpanElement);
const statePanel = element('state', HTMLElement);
const browserState = element('browser-state', HTMLParagraphElement);
const viewer = element('viewer', HTMLIFrameElement);
const cabinet = element('cabinet', HTMLButtonElement);
const brand = element('brand', HTMLImageElement);
const historyStatus = element('history-state', HTMLParagraphElement);
const steps = element('steps', HTMLOListElement);
const stepsContent = element('steps-content', HTMLElement);
const stepsToggle = element('steps-toggle', HTMLButtonElement);
const stepsPanel = element('steps-panel', HTMLElement);
const sessionPanel = element('session-panel', HTMLElement);
const sessionToggle = element('session-toggle', HTMLButtonElement);
const videoToggle = element('video-toggle', HTMLButtonElement);
const expandButton = element('expand', HTMLButtonElement);
const idleWarning = element('idle-warning', HTMLElement);
const idleCountdown = element('idle-countdown', HTMLSpanElement);
const keepOpen = element('keep-open', HTMLButtonElement);
let keepOpenAttempt: { browserId: string; generation: string; key: string } | undefined;
const stepsSearch = element('steps-search', HTMLInputElement);
const stepsPrevious = element('steps-prev', HTMLButtonElement);
const stepsNext = element('steps-next', HTMLButtonElement);
let videoEnabled = true;
let expanded = false;
let historyPage = 1;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTimer: ReturnType<typeof setInterval> | undefined;
const card = element('card', HTMLElement);
const app = new App({ name: 'Helm Glass', version: '1.0.0' }, {});
const viewerId = crypto.randomUUID();
const retryLimit = 8;
let reference: z.infer<typeof presentationReferenceSchema> | undefined;
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
const stepRows = new Map<string, { row: HTMLLIElement; disclosure: HTMLButtonElement; heading: HTMLElement; details: HTMLElement;
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
  if (superseded || tornDown) return;
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
  renderIdle();
  const browser = current?.task.browser;
  if (finishedStatuses.has(current?.task.status ?? '') || browser?.status === 'CLOSED') {
    viewer.hidden = true;
    browserState.hidden = false;
    browserState.textContent = browser?.status === 'CLOSED'
      ? (browser.closeReason === 'IDLE_TIMEOUT' ? 'Браузер закрыт после 15 минут бездействия. ' : 'Браузер закрыт. ')
        + (current?.task.status === 'STOPPED'
          ? 'Задача остановлена окончательно. Шаги и результаты доступны в Helm Glass.'
          : 'Возобновить браузер и задачу можно в Helm Glass; шаги и результаты сохранены.')
      : 'Задача завершена. Шаги и результаты доступны в Helm Glass.';
    return;
  }
  viewer.hidden = !videoEnabled || !browserConnected || !syncReady || !browser || browser.privateMode || browser.status !== 'LIVE';
  browserState.hidden = !viewer.hidden;
  browserState.textContent = !videoEnabled ? 'Трансляция остановлена. Включите её, чтобы видеть браузер.'
    : browser?.privateMode ? 'Защищённый вход открыт в Helm Glass.'
    : !syncReady ? 'Восстанавливаем актуальное состояние браузера…'
    : browserError || (browser?.status === 'LIVE' ? 'Подключаем просмотр браузера…'
      : browser?.status === 'LOST' ? 'Браузер утрачен. Для продолжения требуется восстановление.'
      : browser?.status === 'UNREACHABLE' ? 'Связь с браузером потеряна. Ожидаем восстановления.'
      : browser?.status === 'CLOSING' ? 'Ожидаем закрытия браузера…'
      : browser ? 'Браузер подготавливается…'
      : browserWaiting[current?.task.status ?? ''] ?? 'Браузер подготавливается…');
}

function args(): { taskId: string; generation: string } {
  if (!reference) throw new Error('Задача ещё не получена');
  if (superseded) throw new Error(supersededMessage);
  return { taskId: reference.task.id, generation: reference.generation };
}

function renderIdle(): void {
  const browser = current?.task.browser;
  const seconds = browser?.idleCloseAt ? Math.max(0, Math.ceil((Date.parse(browser.idleCloseAt) - Date.now()) / 1000)) : null;
  idleWarning.hidden = !validated || !syncReady || superseded || tornDown || browser?.status !== 'LIVE'
    || seconds === null || seconds > 300;
  if (seconds !== null) idleCountdown.textContent = 'Браузер закроется из-за простоя через '
    + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + '. Задача сохранится. ';
}

keepOpen.addEventListener('click', async () => {
  if (!current?.task.browser || !validated || !syncReady || superseded || tornDown || keepOpen.disabled) return;
  const binding = args();
  const session = current.task.browser.id;
  keepOpen.disabled = true;
  if (keepOpenAttempt?.browserId !== session || keepOpenAttempt.generation !== binding.generation)
    keepOpenAttempt = { browserId: session, generation: binding.generation, key: crypto.randomUUID() };
  try {
    const result = await tool('widget.keep-open', { ...binding, browserId: session, operationKey: keepOpenAttempt.key });
    keepOpenAttempt = undefined;
    if (!tornDown && !superseded && current?.generation === binding.generation)
      render(presentationSchema.parse(result.structuredContent));
  } catch {
    notice('Продление браузера не подтверждено. Проверьте связь и повторите действие.', true);
  } finally {
    if (!superseded && !tornDown) keepOpen.disabled = false;
  }
});

function retirePresentation(): void {
  if (superseded || tornDown) return;
  if (!current) {
    status.textContent = 'Неактуальный виджет';
    notice(supersededMessage);
  }
  superseded = true;
  validated = false;
  syncReady = false;
  historyGeneration++;
  element('card', HTMLElement).classList.add('superseded');
  card.inert = true;
  clearInterval(sessionTimer);
  clearTimeout(searchTimer);
  element('content', HTMLElement).inert = true;
  cabinet.disabled = true;
  events?.close();
  events = undefined;
  clearTimeout(retryTimer);
  dirty = false;
  clearTimeout(browserRetry);
  browserRetry = undefined;
  if (browserConnected && browserId && metadata) {
    viewer.contentWindow?.postMessage({ type: 'helm-viewer-freeze', viewerEpoch: String(viewerGeneration) },
      new URL(metadata.publicUrl).origin);
    viewerGeneration++;
  } else closeViewer();
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
        && reference?.task.id === binding.taskId && reference.generation === binding.generation) retirePresentation();
    throw new Error(failure.success ? failure.data.message : 'Сервер отклонил запрос.');
  }
  return result;
}

function render(next: Presentation): void {
  if (superseded || tornDown || !validated || reference?.generation !== next.generation
      || reference.task.id !== next.task.id) return;
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
  title.title = next.task.title;
  status.textContent = labels[next.task.status] ?? next.task.status;
  status.setAttribute('data-status', next.task.status);
  const finished = finishedStatuses.has(next.task.status);
  element('content', HTMLElement).inert = false;
  cabinet.disabled = !metadata;
  cabinet.textContent = needsLogin() ? 'Войти на сайт' : 'Открыть в Helm Glass';
  const browser = next.task.browser;
  element('event-count', HTMLSpanElement).textContent = String(next.task.stepCount);
  videoToggle.disabled = !browser || ['CLOSED', 'LOST'].includes(browser.status);
  renderSession();
  if (!sessionTimer && browser?.startedAt && !browser.closedAt) {
    sessionTimer = setInterval(renderClock, 1000);
  }
  if (finished || !browser || browser.status !== 'LIVE' || browser.privateMode || browserId && browser.id !== browserId) closeViewer();
  renderBrowser();
  if (videoEnabled && !finished && syncReady && browser?.status === 'LIVE' && !browserId && !browserRetry && browserAttempts <= retryLimit) void openViewer();
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
  if (superseded || tornDown || !online || !reference || !metadata) return;
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  let requested = reference;
  try {
    do {
      dirty = false;
      requested = reference;
      const response = await tool('widget.state');
      if (reference !== requested || tornDown || superseded || !online) continue;
      const next = widgetStateSchema.parse(response.structuredContent);
      if ('code' in next) retirePresentation();
      else {
        if (next.generation !== requested.generation || next.task.id !== requested.task.id)
          throw new Error('Сервер вернул состояние другой карточки.');
        validated = true;
        syncReady = streamConnected;
        if (syncReady) connectionError = '';
        render(next);
        if (syncReady) {
          reconnects = 0;
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        if (!events && metadata && !retryTimer && reconnects <= retryLimit) connectEvents();
      }
    } while (dirty && !tornDown && !superseded && online);
  } catch {
    if (reference === requested && !superseded && !tornDown && online) {
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
    void refresh();
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
        + '. Это автоматическое продолжение уже показанной задачи: сохраняй текущий виджет, он обновляется событиями.'
        + ' Не вызывай tasks.view и не создавай новую карточку. Получи актуальное состояние страницы и продолжай автономно.'
        + ' Не повторяй уже отправленные операции.' }] });
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
  if (superseded || tornDown) return;
  browserConnected = false;
  browserError = 'Связь с браузером прервана. Восстанавливаем просмотр…';
  renderBrowser();
  if (!videoEnabled || browserRetry || tornDown || superseded || !online) return;
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
  if (!videoEnabled || !validated || !syncReady || !online || !current?.task.browser || !metadata || openingBrowser
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
    if (attempt !== viewerGeneration || superseded || tornDown || current?.generation !== generation
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
      const response = await tool('widget.steps', { page: historyPage, search: stepsSearch.value });
      const content = response.content.find(item => item.type === 'text');
      const history = stepsSchema.parse(content?.type === 'text' ? JSON.parse(content.text) : null);
      if (superseded || tornDown || current?.generation !== generation || request !== historyGeneration) return;
      if (historyDirty) continue;
      const scrollTop = stepsContent.scrollTop;
      const visible = new Set(history.items.map(entry => entry.id));
      for (const [id, view] of stepRows) {
        if (!visible.has(id)) { view.row.remove(); stepRows.delete(id); }
      }
      for (const [index, entry] of history.items.entries()) {
        let view = stepRows.get(entry.id);
        if (!view) {
          const row = document.createElement('li');
          const disclosure = document.createElement('button');
          disclosure.type = 'button';
          disclosure.className = 'step-disclosure';
          const heading = document.createElement('strong');
          const details = document.createElement('small');
          const description = document.createElement('p');
          description.id = 'step-result-' + entry.id;
          description.hidden = true;
          disclosure.setAttribute('aria-controls', description.id);
          disclosure.append(details, heading);
          disclosure.addEventListener('click', () => {
            description.hidden = !description.hidden;
            disclosure.setAttribute('aria-expanded', String(!description.hidden));
          });
          row.append(disclosure, description);
          view = { row, disclosure, heading, details, description, version: -1 };
          stepRows.set(entry.id, view);
        }
        if (entry.version > view.version) {
          view.heading.textContent = entry.title;
          const created = new Date(entry.createdAt);
          view.details.textContent = stepLabels[entry.status] + ' · '
            + created.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          view.details.title = created.toLocaleString('ru-RU');
          view.description.textContent = entry.result ?? '';
          view.disclosure.disabled = !entry.result;
          if (entry.result) {
            view.disclosure.setAttribute('aria-expanded', String(!view.description.hidden));
          } else {
            view.description.hidden = true;
            view.disclosure.removeAttribute('aria-expanded');
          }
          view.version = entry.version;
        }
        if (steps.children[index] !== view.row) steps.insertBefore(view.row, steps.children[index] ?? null);
      }
      stepsContent.scrollTop = scrollTop;
      element('steps-count', HTMLSpanElement).textContent = String(history.total);
      const pages = Math.max(1, Math.ceil(history.total / history.pageSize));
      stepsPrevious.disabled = historyPage <= 1;
      stepsNext.disabled = historyPage >= pages;
      element('steps-page', HTMLSpanElement).textContent = historyPage + ' / ' + pages;
      historyStatus.hidden = history.total !== 0;
      historyStatus.textContent = '';
      if (history.total === 0) {
        historyStatus.textContent = stepsSearch.value.trim()
          ? 'По запросу шаги не найдены.' : 'Бизнес-шаги для этой задачи не записаны.';
      }
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
  const next = presentationReferenceSchema.safeParse(response.structuredContent);
  const meta = metadataSchema.safeParse(response._meta);
  if (response.isError || !next.success || !meta.success
      || ![meta.data.taskUrl, meta.data.loginUrl].every(value => new URL(value).pathname === '/tasks/' + next.data.task.id)) {
    const failure = toolErrorSchema.safeParse(response.structuredContent);
    notice(failure.success ? failure.data.message : 'Не удалось открыть карточку задачи. Обновите страницу чата.', true);
    if (!reference) {
      title.textContent = 'Карточка задачи недоступна';
      status.textContent = 'Ошибка загрузки';
      browserState.textContent = 'Данные задачи недоступны.';
      historyStatus.textContent = 'Шаги недоступны.';
    }
    return;
  }
  const changed = reference?.generation !== next.data.generation || reference.task.id !== next.data.task.id;
  if (changed) {
    reference = next.data;
    current = undefined;
    validated = false;
    syncReady = false;
    streamConnected = false;
    events?.close();
    events = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearInterval(sessionTimer);
    sessionTimer = undefined;
    closeViewer();
    historyGeneration++;
    historyDirty = true;
    historyPage = 1;
    stepsSearch.value = '';
    stepRows.clear();
    steps.replaceChildren();
    element('event-count', HTMLSpanElement).textContent = '';
    element('steps-count', HTMLSpanElement).textContent = '';
    historyStatus.hidden = false;
    historyStatus.textContent = 'Получаем шаги…';
    cabinet.disabled = true;
    title.textContent = 'Получаем задачу…';
    status.textContent = 'Подключение';
    status.removeAttribute('data-status');
    connectionError = '';
    renderBrowser();
  }
  metadata = meta.data;
  brand.src = new URL('/helm-logo.png', metadata.publicUrl).href;
  if (streamUrl !== metadata.eventsUrl) {
    streamUrl = metadata.eventsUrl;
    streamCursor = '';
    reconnects = 0;
  }
  void refresh();
};

function recover(): void {
  online = navigator.onLine;
  if (!online) return;
  if (tornDown || superseded || !reference || document.visibilityState === 'hidden') return;
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
  clearTimeout(searchTimer);
  clearInterval(sessionTimer);
  sessionTimer = undefined;
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
  clearTimeout(searchTimer);
  clearInterval(sessionTimer);
  closeViewer();
  window.removeEventListener('online', recover);
  window.removeEventListener('offline', offline);
  document.removeEventListener('visibilitychange', recover);
  return {};
};

cabinet.addEventListener('click', () => {
  if (metadata && validated && !superseded) {
    void app.openLink({ url: needsLogin() ? metadata.loginUrl : metadata.taskUrl })
      .then(result => { if (result.isError) notice('Не удалось открыть задачу в Helm Glass.', true); })
      .catch(() => notice('Не удалось открыть задачу в Helm Glass.', true));
  }
});

stepsToggle.addEventListener('click', () => {
  if (superseded || tornDown) return;
  stepsPanel.hidden = !stepsPanel.hidden;
  sessionPanel.hidden = true;
  updatePanels();
});

function updatePanels(): void {
  card.classList.toggle('panels-collapsed', !!stepsPanel.hidden && !!sessionPanel.hidden);
  stepsToggle.setAttribute('aria-expanded', String(!stepsPanel.hidden));
  const label = stepsPanel.hidden ? 'Показать шаги' : 'Скрыть шаги';
  stepsToggle.setAttribute('aria-label', label);
  stepsToggle.title = label;
  sessionToggle.setAttribute('aria-expanded', String(!sessionPanel.hidden));
  const sessionLabel = sessionPanel.hidden ? 'Показать сессию' : 'Скрыть сессию';
  sessionToggle.setAttribute('aria-label', sessionLabel);
  sessionToggle.title = sessionLabel;
  if (!sessionPanel.hidden) {
    renderSession();
  }
}

function renderClock(): void {
  if (superseded || tornDown) return;
  renderIdle();
  if (!sessionPanel.hidden) renderSession();
}

function renderSession(): void {
  renderIdle();
  const browser = current?.task.browser;
  const states: Record<string, string> = { LIVE: 'Работает', CLOSED: 'Закрыт', LOST: 'Утрачен', CLOSING: 'Закрывается', STARTING: 'Запускается', QUEUED: 'Ожидает запуска', UNREACHABLE: 'Нет связи' };
  element('session-id', HTMLElement).textContent = browser?.id ?? 'Нет данных';
  element('session-status', HTMLElement).textContent = browser ? states[browser.status] ?? browser.status : 'Не запущен';
  element('session-start', HTMLElement).textContent = browser?.startedAt ? new Date(browser.startedAt).toLocaleString('ru-RU') : 'Нет данных';
  element('session-closed-row', HTMLElement).hidden = !browser?.closedAt;
  element('session-closed', HTMLElement).textContent = browser?.closedAt ? new Date(browser.closedAt).toLocaleString('ru-RU') : '';
  const seconds = browser?.startedAt ? Math.max(0, Math.floor(((browser.closedAt ? Date.parse(browser.closedAt) : Date.now()) - Date.parse(browser.startedAt)) / 1000)) : null;
  element('session-duration', HTMLElement).textContent = seconds === null || !Number.isFinite(seconds) ? 'Нет данных' : [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  element('session-control', HTMLElement).textContent = browser?.controlOwner === 'USER' ? 'Пользователь в Helm Glass' : browser?.controlOwner === 'CHATGPT' ? 'Агент' : browser?.controlOwner === 'TRANSFERRING' ? 'Передача управления' : '—';
  if (browser?.closedAt) { clearInterval(sessionTimer); sessionTimer = undefined; }
}

sessionToggle.addEventListener('click', () => {
  if (superseded || tornDown) return;
  sessionPanel.hidden = !sessionPanel.hidden;
  stepsPanel.hidden = true;
  updatePanels();
});
videoToggle.addEventListener('click', () => {
  videoEnabled = !videoEnabled;
  const label = videoEnabled ? 'Остановить трансляцию' : 'Возобновить трансляцию';
  videoToggle.setAttribute('aria-label', label); videoToggle.title = label;
  videoToggle.setAttribute('aria-pressed', String(!videoEnabled));
  if (!videoEnabled) closeViewer(); else void openViewer();
  renderBrowser();
});
element('copy-session', HTMLButtonElement).addEventListener('click', () => {
  if (current?.task.browser) void navigator.clipboard.writeText(current.task.browser.id)
    .then(() => notice('Идентификатор браузера скопирован.'))
    .catch(() => notice('Выделите идентификатор и скопируйте его вручную.', true));
});
function changeHistoryPage(page: number): void {
  historyPage = page; historyDirty = true;
  void loadHistory();
}
stepsPrevious.addEventListener('click', () => changeHistoryPage(Math.max(1, historyPage - 1)));
stepsNext.addEventListener('click', () => changeHistoryPage(historyPage + 1));
stepsSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  historyDirty = true;
  searchTimer = setTimeout(() => changeHistoryPage(1), 250);
});
function updateHostLayout(): void {
  if (superseded || tornDown) return;
  const context = app.getHostContext();
  const dimensions = context?.containerDimensions;
  const availableHeight = dimensions && ('height' in dimensions ? dimensions.height : dimensions.maxHeight);
  const insets = context?.safeAreaInsets;
  document.body.style.padding = `${insets?.top ?? 0}px ${insets?.right ?? 0}px ${insets?.bottom ?? 0}px ${insets?.left ?? 0}px`;
  card.style.maxHeight = typeof availableHeight === 'number' && Number.isFinite(availableHeight) && availableHeight > 0
    ? Math.max(0, availableHeight - (insets?.top ?? 0) - (insets?.bottom ?? 0)) + 'px' : 'none';
}

function expandBrowser(value: boolean): void {
  if (superseded || tornDown) return;
  expanded = value;
  card.classList.toggle('expanded', expanded);
  const label = expanded ? 'Свернуть браузер' : 'Развернуть браузер';
  expandButton.setAttribute('aria-label', label); expandButton.title = label;
  document.getElementById('expand-path')?.setAttribute('d', expanded ? 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5' : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5');
  expandButton.focus();
}
expandButton.addEventListener('click', () => expandBrowser(!expanded));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && expanded) expandBrowser(false); });
app.onhostcontextchanged = updateHostLayout;

window.addEventListener('online', recover);
window.addEventListener('offline', offline);
document.addEventListener('visibilitychange', recover);
window.addEventListener('message', event => {
  if (!validated || superseded || tornDown || !online || !metadata || !browserId
      || event.source !== viewer.contentWindow || event.origin !== new URL(metadata.publicUrl).origin
      || typeof event.data !== 'object' || event.data === null || Reflect.get(event.data, 'type') !== 'helm-viewer'
      || Reflect.get(event.data, 'viewerEpoch') !== String(viewerGeneration)) return;
  const state = Reflect.get(event.data, 'state');
  if (state === 'escape') {
    if (expanded) expandBrowser(false);
    return;
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

updatePanels();
updateHostLayout();
try { await app.connect(); updateHostLayout(); }
catch { notice('Этот чат не поддерживает интерактивный виджет. Откройте задачу по ссылке Helm Glass в ответе инструмента.', true); }
