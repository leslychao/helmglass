import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { Status } from '../shared/ui';

const stateSchema = z.object({
  analysisId: z.string(), artifactId: z.string(), mode: z.enum(['transcript', 'full']),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']), version: z.number(),
  transcriptComplete: z.boolean(), acousticsComplete: z.boolean(), emotionsComplete: z.boolean(),
  intervalsComplete: z.boolean(), qualityFlags: z.array(z.string()),
  stages: z.record(z.string(), z.enum(['NOT_REQUESTED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'])),
  processedSeconds: z.number(), durationSeconds: z.nullable(z.number()),
  stageErrors: z.record(z.string(), z.string()), errorCode: z.nullable(z.string()),
  tempo: z.object({ recognizedWords: z.number(), speechSeconds: z.number(),
    withPausesWpm: z.nullable(z.number()), withoutPausesWpm: z.nullable(z.number()) }),
});
const itemSchema = z.object({
  start: z.number(), end: z.number(), text: z.optional(z.string()), kind: z.optional(z.string()),
  rmsDbfs: z.optional(z.nullable(z.number())), peakDbfs: z.optional(z.nullable(z.number())),
  digitalSilence: z.optional(z.boolean()), f0Hz: z.optional(z.nullable(z.number())),
  strength: z.optional(z.number()), deltaHz: z.optional(z.nullable(z.number())),
  reason: z.optional(z.nullable(z.string())), scores: z.optional(z.nullable(z.record(z.string(), z.number()))),
});
const pageSchema = z.object({ ...stateSchema.shape, items: z.array(itemSchema),
  sectionComplete: z.boolean(), hasMore: z.boolean(), nextCursor: z.nullable(z.string()) });
const latestSchema = z.object({ available: z.boolean(), analysis: z.optional(stateSchema) });
type Section = 'transcript' | 'intervals' | 'acoustics' | 'emotions';

@Component({
  selector: 'hg-audio-analysis',
  imports: [Status],
  template: `
    <section class="audio-analysis" [attr.aria-busy]="busy()">
      <div class="toolbar">
        <strong>{{ name() }}</strong><span class="spacer"></span>
        <button class="button" [disabled]="busy()" (click)="analyze('transcript')">Расшифровать</button>
        <button class="button" [disabled]="busy()" (click)="analyze('full')">Полный анализ</button>
        <a class="button" [href]="'/api/artifacts/' + id() + '/download'" download>Скачать оригинал</a>
      </div>
      @if (state(); as analysis) {
        <p class="progress" role="status"><hg-status [value]="analysis.status" />
          Обработано {{ number(analysis.processedSeconds) }} с
          @if (analysis.durationSeconds !== null) { из {{ number(analysis.durationSeconds) }} с }
          · Текст: {{ stage(analysis.stages['transcript']) }}
          · Речь и паузы: {{ stage(analysis.stages['intervals']) }}
          @if (analysis.mode === 'full') {
            · Измерения: {{ stage(analysis.stages['acoustics']) }}
            · Эмоции: {{ stage(analysis.stages['emotions']) }}
          }
        </p>
        @if (failures()) { <p class="error-banner" role="alert">{{ failures() }}</p> }
        @if (analysis.qualityFlags.includes('NO_SPEECH_DETECTED')) {
          <p class="notice">Речь не обнаружена. Это результат проверки, а не ошибка распознавания.</p>
        }
        <div class="toolbar" aria-label="Результаты анализа">
          @for (tab of tabs; track tab.id) {
            <button class="button" [attr.aria-pressed]="section() === tab.id"
              (click)="select(tab.id)">{{ tab.label }}</button>
          }
          @if (section() !== 'transcript') {
            <label>От, с <input type="number" min="0" [value]="from()" (change)="setFrom($event)" /></label>
            <span>до {{ from() + 20 }} с</span>
          }
        </div>
        @if (page(); as data) {
          @if (!data.sectionComplete) { <p class="notice">Показана доступная часть. Стадия ещё не завершена.</p> }
          @if (data.items.length) {
            <div class="measurements">
              @for (item of data.items; track $index) {
                <div class="measurement"><time>{{ number(item.start) }}–{{ number(item.end) }} с</time>
                  @if (item.text !== undefined) { <span>{{ item.text }}</span> }
                  @else if (item.kind === 'loudness') {
                    <span>RMS {{ number(item.rmsDbfs) }} dBFS · Пик {{ number(item.peakDbfs) }} dBFS
                      @if (item.digitalSilence) { · Цифровая тишина }</span>
                  } @else if (item.kind === 'pitch') {
                    <span>F0 {{ number(item.f0Hz) }} Гц · Изменение {{ number(item.deltaHz) }} Гц
                      @if (item.reason) { · {{ reason(item.reason) }} }</span>
                  } @else if (item.kind) { <span>{{ item.kind === 'speech' ? 'Речь' : 'Пауза' }}</span> }
                  @else { <span>{{ scores(item.scores) }} {{ reason(item.reason) }}</span> }
                </div>
              }
            </div>
          } @else { <p class="empty-small">В этом разделе и диапазоне пока нет данных.</p> }
          <div class="toolbar">
            <button class="button" [disabled]="busy() || !cursor()" (click)="first()">В начало</button>
            <button class="button" [disabled]="busy() || !data.hasMore" (click)="next()">Следующая страница</button>
          </div>
          @if (analysis.mode === 'full') {
            <p>Темп по распознанным словам: {{ number(analysis.tempo.withPausesWpm) }} слов/мин с паузами;
              {{ number(analysis.tempo.withoutPausesWpm) }} без пауз.</p>
          }
          <p class="limitation">Таймкоды оценочные. Модель не разделяет голоса: перекрытия ограничивают анализ.
            Оценки эмоций — выход классификатора, а не достоверные вероятности чувств человека.</p>
        }
      }
      @if (error()) { <p class="error-banner" role="alert">{{ error() }}
        <button class="text-button" (click)="refresh()">Повторить чтение</button></p> }
    </section>
  `,
  styles: `
    :host { display:block; }
    .audio-analysis { border:1px solid var(--line); border-radius:7px; padding:16px; }
    .toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .toolbar label { display:flex; align-items:center; gap:6px; }
    input { width:90px; }
    .progress { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .measurements { max-height:380px; overflow:auto; margin:12px 0; }
    .measurement { display:flex; gap:16px; padding:4px 0; border-bottom:1px solid var(--line); }
    time { min-width:130px; color:var(--muted); font-variant-numeric:tabular-nums; }
    .limitation { color:var(--muted); font-size:12px; }
    [aria-pressed=true] { border-color:var(--accent); }
  `,
})
export class AudioAnalysis {
  readonly id = input.required<string>();
  readonly name = input.required<string>();
  readonly state = signal<z.infer<typeof stateSchema> | null>(null);
  readonly page = signal<z.infer<typeof pageSchema> | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly section = signal<Section>('transcript');
  readonly cursor = signal('');
  readonly from = signal(0);
  readonly tabs: readonly { id: Section; label: string }[] = [
    { id: 'transcript', label: 'Текст' }, { id: 'intervals', label: 'Речь и паузы' },
    { id: 'acoustics', label: 'Измерения' }, { id: 'emotions', label: 'Оценки эмоций' },
  ];
  readonly failures = computed(() => {
    const current = this.state();
    return current ? [current.errorCode, ...Object.values(current.stageErrors)]
      .filter(Boolean).map(value => this.reason(value)).join('; ') : '';
  });
  private readonly api = inject(Api);
  private generation = 0;
  private disposed = false;
  private initialized = false;

  stage(value: string | undefined): string {
    const labels: Record<string, string> = { NOT_REQUESTED: 'не запрошено', QUEUED: 'в очереди',
      RUNNING: 'выполняется', SUCCEEDED: 'готово', FAILED: 'ошибка' };
    return value ? labels[value] ?? value : 'неизвестно';
  }

  constructor() {
    effect(() => {
      this.id();
      this.initialized = true;
      this.state.set(null);
      this.page.set(null);
      this.cursor.set('');
      void this.refresh();
    });
    inject(LiveEvents).watch(['audio-analysis', 'sync']).pipe(takeUntilDestroyed()).subscribe(event => {
      if (!this.initialized) return;
      if (event.resource === 'sync' || !this.state() || event.entityId === this.state()?.analysisId) void this.refresh();
    });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.generation++; });
  }

  async analyze(mode: 'transcript' | 'full') {
    if (this.busy()) return;
    const id = this.id();
    this.busy.set(true);
    this.error.set('');
    try {
      const state = await this.api.mutate('/api/artifacts/' + id + '/analysis', { mode }, stateSchema);
      if (!this.disposed && this.id() === id) {
        this.acceptState(state);
        await this.refresh();
      }
    } catch (error: unknown) { if (!this.disposed && this.id() === id) this.error.set(errorMessage(error)); }
    finally { if (!this.disposed) this.busy.set(false); }
  }

  async refresh() {
    const generation = ++this.generation;
    try {
      const latest = await this.api.get('/api/artifacts/' + this.id() + '/analysis', latestSchema);
      if (generation !== this.generation) return;
      if (!latest.analysis) return;
      if (!this.acceptState(latest.analysis)) return;
      const page = await this.api.get('/api/audio/analyses/' + latest.analysis.analysisId, pageSchema, {
        section: this.section(), cursor: this.cursor() || '0', limit: 100,
        from: this.section() === 'transcript' ? undefined : this.from(),
        to: this.section() === 'transcript' ? undefined : this.from() + 20,
      });
      if (generation !== this.generation || !this.acceptState(page)) return;
      this.page.set(page);
      this.error.set('');
    } catch (error: unknown) { if (generation === this.generation) this.error.set(errorMessage(error)); }
  }

  private acceptState(next: z.infer<typeof stateSchema>): boolean {
    const current = this.state();
    if (next.analysisId === current?.analysisId && next.version < current.version) return false;
    if (next.analysisId !== current?.analysisId) {
      this.cursor.set('');
      this.page.set(null);
    }
    this.state.set(next);
    return true;
  }

  select(section: Section) { this.section.set(section); this.first(); }
  first() { this.cursor.set(''); void this.refresh(); }
  next() { const cursor = this.page()?.nextCursor; if (cursor) { this.cursor.set(cursor); void this.refresh(); } }
  setFrom(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value >= 0) { this.from.set(value); this.first(); }
  }
  number(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 }); }
  scores(values: Record<string, number> | null | undefined) {
    return values ? Object.entries(values).map(([name, score]) => name + ': ' + score.toFixed(3)).join(' · ') : '';
  }
  reason(value: string | null | undefined) {
    if (!value) return '';
    const labels: Record<string, string> = { unvoiced: 'нет надёжного тона', unreliable: 'ненадёжный тон',
      insufficient_context: 'недостаточно сигнала для оценки тона',
      too_short: 'слишком короткий интервал', EMOTION_FAILED: 'не удалось оценить эмоции',
      DECODE_FAILED: 'запись повреждена или её формат не поддерживается',
      ASR_FAILED: 'не удалось распознать речь', ACOUSTICS_FAILED: 'не удалось измерить звучание',
      SPEECH_WITHOUT_TEXT: 'речь обнаружена, но текст не распознан',
      PROCESSOR_VERSION_CHANGED: 'модели обновлены — запустите анализ ещё раз',
      PROCESSOR_CONNECTION_LOST: 'связь с обработчиком прервана',
      PROCESSOR_BUSY: 'обработчик занят', LEASE_EXPIRED: 'обработка восстанавливается после прерывания' };
    return labels[value] ?? value;
  }
}
