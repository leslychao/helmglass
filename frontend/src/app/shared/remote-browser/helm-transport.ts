export interface StreamState {
  type: 'streamState';
  sessionId: string;
  pageEpoch: number;
  privacyEpoch: number;
  mediaGeneration: number;
  viewGeneration: number;
  producerId: string;
  viewport: { width: number; height: number };
  captureState: string;
  iceServers: RTCIceServer[];
}

export function streamStateOf(value: unknown): StreamState | null {
  if (typeof value !== 'object' || !value || !('type' in value) || value.type !== 'streamState')
    return null;
  if (
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !('producerId' in value) ||
    typeof value.producerId !== 'string'
  )
    return null;
  if (
    !('pageEpoch' in value) ||
    typeof value.pageEpoch !== 'number' ||
    !('privacyEpoch' in value) ||
    typeof value.privacyEpoch !== 'number' ||
    !('mediaGeneration' in value) ||
    typeof value.mediaGeneration !== 'number' ||
    !('viewGeneration' in value) ||
    typeof value.viewGeneration !== 'number'
  )
    return null;
  if (
    !('viewport' in value) ||
    typeof value.viewport !== 'object' ||
    !value.viewport ||
    !('width' in value.viewport) ||
    typeof value.viewport.width !== 'number' ||
    !('height' in value.viewport) ||
    typeof value.viewport.height !== 'number'
  )
    return null;
  if (
    !('captureState' in value) ||
    typeof value.captureState !== 'string' ||
    !('iceServers' in value) ||
    !Array.isArray(value.iceServers)
  )
    return null;
  if (
    ![value.pageEpoch, value.privacyEpoch, value.mediaGeneration, value.viewGeneration].every(
      (epoch) => Number.isSafeInteger(epoch) && epoch >= 0,
    )
  )
    return null;
  if (
    ![value.viewport.width, value.viewport.height].every(
      (size) => Number.isSafeInteger(size) && size > 0 && size <= 16384,
    )
  )
    return null;
  if (!value.sessionId || !value.producerId) return null;
  const iceServers: RTCIceServer[] = [];
  for (const item of value.iceServers) {
    if (typeof item !== 'object' || !item || !('urls' in item)) return null;
    const urls: unknown = item.urls;
    if (
      typeof urls !== 'string' &&
      !(Array.isArray(urls) && urls.every((url: unknown) => typeof url === 'string'))
    )
      return null;
    if (
      !(typeof urls === 'string' ? [urls] : urls).every((url: string) =>
        /^turns?:[^\s]+$/.test(url),
      )
    )
      return null;
    iceServers.push({
      urls,
      username: 'username' in item && typeof item.username === 'string' ? item.username : undefined,
      credential:
        'credential' in item && typeof item.credential === 'string' ? item.credential : undefined,
    });
  }
  return {
    type: 'streamState',
    sessionId: value.sessionId,
    pageEpoch: value.pageEpoch,
    privacyEpoch: value.privacyEpoch,
    mediaGeneration: value.mediaGeneration,
    viewGeneration: value.viewGeneration,
    producerId: value.producerId,
    viewport: { width: value.viewport.width, height: value.viewport.height },
    captureState: value.captureState,
    iceServers,
  };
}

/** A private socket instance; never replaces the global WebSocket constructor. */
export class HelmTransport {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly socket: WebSocket;
  private authenticated = false;
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    url: string,
    ticket: string,
    private readonly streamState: (state: StreamState) => void,
    closed: (code: number) => void,
  ) {
    this.socket = new WebSocket(url);
    this.deadline = setTimeout(() => this.close(), 15000);
    this.socket.onopen = () => this.socket.send(JSON.stringify({ type: 'authenticate', ticket }));
    this.socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string' || event.data.length > 262144) {
        this.close();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.close();
        return;
      }
      const state = streamStateOf(message);
      if (state) {
        this.authenticated = true;
        clearTimeout(this.deadline);
        this.streamState(state);
        return;
      }
      if (
        typeof message === 'object' &&
        message &&
        'type' in message &&
        (message.type === 'revoked' || message.type === 'streamEnded')
      ) {
        this.close();
        return;
      }
      if (!this.authenticated) {
        this.close();
        return;
      }
      this.onmessage?.(new MessageEvent<string>('message', { data: event.data }));
    };
    this.socket.onerror = () =>
      this.onerror?.(new ErrorEvent('error', { message: 'Не удалось подключить видеоканал' }));
    this.socket.onclose = (event) => {
      clearTimeout(this.deadline);
      this.onclose?.();
      closed(event.code);
    };
  }
  send(data: string) {
    if (!this.authenticated || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Signaling not authenticated');
    this.socket.send(data);
  }
  close() {
    clearTimeout(this.deadline);
    this.socket.close();
  }
}
