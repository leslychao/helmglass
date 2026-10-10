import RFB, { CLIPBOARD_TEXT_LIMIT } from './core/rfb.js?helmClipboard=1';

export function startViewer(parentOrigin) {
  let rfb, pending, activeEpoch, connected = false, frozen = false, generation = 0;
  let operation;
  const intercepted = new Set();
  const report = (state, epoch, details = {}) => {
    const canvas = document.querySelector('#screen canvas');
    window.parent.postMessage({ type: 'helm-viewer', state, viewerEpoch: epoch,
      width: canvas?.width, height: canvas?.height, ...details }, parentOrigin);
  };
  const validText = text => typeof text === 'string' && text.length <= CLIPBOARD_TEXT_LIMIT
    && !text.includes('\0') && new TextEncoder().encode(text).length <= CLIPBOARD_TEXT_LIMIT;
  const current = (connection, epoch) => connection === rfb && epoch === activeEpoch
    && connected && !connection.viewOnly && !frozen;
  const cancel = () => {
    operation?.abort();
    operation = undefined;
    intercepted.clear();
  };
  function waitFor(connection, type, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        connection.removeEventListener(type, receive);
        signal.removeEventListener('abort', abort);
      };
      const receive = event => { cleanup(); resolve(event); };
      const abort = () => { cleanup(); reject(new Error('Операция с буфером отменена.')); };
      if (signal.aborted) { abort(); return; }
      connection.addEventListener(type, receive);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  function shortcut(connection, keysym, code) {
    connection.sendKey(0xffe3, 'ControlLeft', true);
    connection.sendKey(keysym, code);
    connection.sendKey(0xffe3, 'ControlLeft', false);
  }
  async function runClipboard(work) {
    const connection = rfb, epoch = activeEpoch;
    if (!connection || !current(connection, epoch)) return;
    if (operation) {
      report('clipboard', epoch, { busy: true, error: 'Дождитесь завершения операции с буфером.' });
      return;
    }
    const controller = new AbortController();
    operation = controller;
    report('clipboard', epoch, { busy: true, error: '' });
    const timer = setTimeout(() => controller.abort(), 5000);
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(new Error('Операция с буфером отменена.'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([work(connection, epoch, controller.signal), aborted]); }
    catch (error) {
      if (operation === controller && current(connection, epoch)) report('clipboard', epoch, { manual: true,
        error: controller.signal.aborted ? 'Обмен буфером не завершён за пять секунд. Повторите действие.'
          : error instanceof Error ? error.message : 'Не удалось передать текст.' });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (operation === controller) {
        operation = undefined;
        if (current(connection, epoch)) report('clipboard', epoch, { busy: false });
      }
    }
  }
  async function paste(connection, epoch, signal, text) {
    if (!validText(text)) throw new Error('Допустим текст до 256 КиБ UTF-8 без нулевых символов.');
    if (signal.aborted || !current(connection, epoch)) return;
    const sent = waitFor(connection, 'clipboardsent', signal);
    connection.clipboardPasteFrom(text);
    await sent;
    if (!signal.aborted && current(connection, epoch)) shortcut(connection, 0x76, 'KeyV');
  }
  function connect(next) {
    const rawPath = next.searchParams.get('path');
    if (!rawPath) throw new Error('Missing transport');
    const transport = new URL(rawPath, window.location.origin + '/');
    const prefix = window.location.pathname.slice(0, window.location.pathname.indexOf('/novnc/'));
    if (transport.origin !== window.location.origin || !transport.pathname.startsWith(prefix + '/sessions/')
        || !transport.pathname.endsWith('/view') || !transport.searchParams.has('ticket')) throw new Error('Invalid transport');
    transport.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ownGeneration = ++generation, epoch = next.searchParams.get('viewerEpoch') ?? '';
    activeEpoch = epoch;
    const connection = new RFB(document.getElementById('screen'), transport.href);
    rfb = connection;
    connection.viewOnly = next.searchParams.get('view_only') === '1';
    connection.scaleViewport = true;
    connection.resizeSession = false;
    const dimensions = new MutationObserver(() => { if (ownGeneration === generation) report('resized', epoch); });
    dimensions.observe(document.getElementById('screen'), { subtree: true, childList: true,
      attributes: true, attributeFilter: ['width', 'height'] });
    connection.addEventListener('connect', () => {
      if (ownGeneration !== generation) return;
      connected = true;
      report('connected', epoch);
    });
    connection.addEventListener('securityfailure', () => { if (ownGeneration === generation) report('error', epoch); });
    connection.addEventListener('clipboard', event => {
      if (!current(connection, epoch)) return;
      if (validText(event.detail.text)) report('clipboard', epoch, { text: event.detail.text });
    });
    connection.addEventListener('clipboarderror', () => {
      if (!current(connection, epoch)) return;
      report('clipboard', epoch, { manual: true, error: 'Текст превышает 256 КиБ UTF-8 или сервер не поддерживает обмен.' });
      cancel();
      report('clipboard', epoch, { busy: false });
    });
    connection.addEventListener('disconnect', () => {
      dimensions.disconnect();
      if (ownGeneration !== generation) return;
      connected = false;
      cancel();
      rfb = undefined;
      if (pending) { const target = pending; pending = undefined; connect(target); }
      else report('disconnected', epoch);
    });
  }
  window.addEventListener('message', async event => {
    if (event.source !== window.parent || event.origin !== parentOrigin || frozen
        || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'helm-viewer-freeze') {
      if (event.data.viewerEpoch !== activeEpoch || rfb && !rfb.viewOnly) return;
      frozen = true;
      generation++;
      pending = undefined;
      cancel();
      try {
        const canvas = document.querySelector('#screen canvas');
        if (canvas) {
          const snapshot = document.createElement('canvas'), bounds = canvas.getBoundingClientRect();
          snapshot.width = canvas.width; snapshot.height = canvas.height;
          const context = snapshot.getContext('2d');
          if (context) {
            context.drawImage(canvas, 0, 0);
            snapshot.style.cssText = 'position:fixed;left:' + bounds.left + 'px;top:' + bounds.top
              + 'px;width:' + bounds.width + 'px;height:' + bounds.height + 'px';
            document.body.append(snapshot);
          }
        }
      } finally { rfb?.disconnect(); rfb = undefined; connected = false; }
      return;
    }
    if (event.data.type === 'helm-viewer-paste') {
      if (event.data.viewerEpoch !== activeEpoch || typeof event.data.text !== 'string') return;
      const text = event.data.text;
      await runClipboard(async (connection, epoch, signal) => {
        connection.focus();
        await paste(connection, epoch, signal, text);
      });
      return;
    }
    if (typeof event.data.url !== 'string') return;
    if (event.data.type === 'helm-viewer-navigate') {
      if (event.data.viewerEpoch !== activeEpoch) return;
      let target;
      try { target = new URL(event.data.url); } catch { return; }
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password
          || target.href.length > 4096) return;
      await runClipboard(async (connection, epoch, signal) => {
        shortcut(connection, 0x6c, 'KeyL');
        await paste(connection, epoch, signal, target.href);
        // Chromium handles paste asynchronously before submitting the address.
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!signal.aborted && current(connection, epoch)) connection.sendKey(0xff0d, 'Enter');
      });
      return;
    }
    if (event.data.type !== 'helm-viewer-reconnect') return;
    try {
      const next = new URL(event.data.url, location.href);
      if (next.origin !== location.origin || next.pathname !== location.pathname) return;
      cancel();
      connected = false;
      if (rfb) { pending = next; rfb.disconnect(); } else connect(next);
    } catch { report('error', ''); }
  });
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || !rfb || !current(rfb, activeEpoch) || event.target?.tagName !== 'CANVAS'
        || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey
        || !['KeyC', 'KeyV'].includes(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    intercepted.add(event.code);
    if (event.repeat) return;
    report('activity', activeEpoch);
    void runClipboard(async (connection, epoch, signal) => {
      if (event.code === 'KeyV') {
        let text;
        try { text = await navigator.clipboard.readText(); }
        catch { throw new Error('Вставьте текст в панель «Буфер обмена»: браузер ограничил доступ к буферу компьютера.'); }
        await paste(connection, epoch, signal, text);
      } else {
        const copied = waitFor(connection, 'clipboard', signal);
        shortcut(connection, 0x63, 'KeyC');
        const received = await copied;
        if (signal.aborted || !current(connection, epoch) || !validText(received.detail.text)) return;
        try { await navigator.clipboard.writeText(received.detail.text); }
        catch { throw new Error('Скопируйте полученный текст из панели «Буфер обмена»: браузер ограничил доступ к буферу компьютера.'); }
      }
    });
  }, true);
  document.addEventListener('keyup', event => {
    if (!intercepted.delete(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
    document.addEventListener(type, event => {
      if (event.isTrusted && rfb && current(rfb, activeEpoch)) report('activity', activeEpoch);
    }, { capture: true, passive: true });
  }
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && activeEpoch !== undefined) report('escape', activeEpoch);
  }, true);
  window.addEventListener('pagehide', cancel);
  try { connect(new URL(location.href)); }
  catch { report('error', new URL(location.href).searchParams.get('viewerEpoch') ?? ''); }
}
