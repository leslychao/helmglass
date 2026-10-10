import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import * as z from 'zod/mini';
import { Api, errorMessage } from '../core/api';
import { LiveEvents } from '../core/live-events';
import { DataTable, TableCell } from '../shared/data-table';
import { Icon } from '../shared/icon';
import { QueryState } from '../shared/query-state';
import { TableColumn, TableViews } from '../shared/table-view';
import { Tooltip } from '../shared/tooltip';

const stateSchema = z.object({
  analysisId: z.string(),
  artifactId: z.string(),
  mode: z.enum(['transcript', 'full']),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']),
  version: z.number(),
  transcriptComplete: z.boolean(),
  acousticsComplete: z.boolean(),
  emotionsComplete: z.boolean(),
  intervalsComplete: z.boolean(),
  qualityFlags: z.array(z.string()),
  stages: z.record(
    z.string(),
    z.enum(['NOT_REQUESTED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  ),
  processedSeconds: z.number(),
  durationSeconds: z.nullable(z.number()),
  stageErrors: z.record(z.string(), z.string()),
  errorCode: z.nullable(z.string()),
  tempo: z.object({
    recognizedWords: z.number(),
    speechSeconds: z.number(),
    withPausesWpm: z.nullable(z.number()),
    withoutPausesWpm: z.nullable(z.number()),
  }),
});
const itemSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.optional(z.string()),
  kind: z.optional(z.string()),
  rmsDbfs: z.optional(z.nullable(z.number())),
  peakDbfs: z.optional(z.nullable(z.number())),
  digitalSilence: z.optional(z.boolean()),
  f0Hz: z.optional(z.nullable(z.number())),
  strength: z.optional(z.number()),
  deltaHz: z.optional(z.nullable(z.number())),
  reason: z.optional(z.nullable(z.string())),
  scores: z.optional(z.nullable(z.record(z.string(), z.number()))),
});
const pageSchema = z.object({
  ...stateSchema.shape,
  items: z.array(itemSchema),
  sectionComplete: z.boolean(),
  hasMore: z.boolean(),
  nextCursor: z.nullable(z.string()),
});
const latestSchema = z.object({ available: z.boolean(), analysis: z.optional(stateSchema) });
type Section = 'transcript' | 'intervals' | 'acoustics' | 'emotions';

@Component({
  selector: 'hg-audio-analysis',
  imports: [DataTable, TableCell, Icon, Tooltip],
  template: `
    <section class="audio-analysis">
      <header class="audio-heading">
        <a
          class="audio-download"
          [href]="'/api/artifacts/' + id() + '/download'"
          download
          [attr.aria-label]="'Скачать оригинал: ' + name()"
          hgTooltip="Скачать оригинал"
        >
          <span>{{ name() }}</span
          ><hg-icon name="arrow-down" />
        </a>
        @if (state(); as analysis) {
          @if (analysis.durationSeconds !== null) {
            <span class="audio-duration">{{ number(analysis.durationSeconds) }} с</span>
          }
        }
      </header>
      @if (state(); as analysis) {
        @if (analysis.status === 'QUEUED') {
          <p class="progress" role="status">Анализ в очереди.</p>
        } @else if (analysis.status === 'RUNNING') {
          <p class="progress" role="status">
            Обработано {{ number(analysis.processedSeconds) }} с
            @if (analysis.durationSeconds !== null) {
              из {{ number(analysis.durationSeconds) }} с
            }
          </p>
        } @else if (analysis.status === 'PARTIAL' || analysis.status === 'FAILED') {
          <p class="notice" role="status">
            {{
              analysis.status === 'PARTIAL'
                ? 'Анализ завершён частично. Доступные результаты сохранены.'
                : 'Не удалось завершить анализ.'
            }}
          </p>
        }
        @if (failures()) {
          <p class="error-banner" role="alert">{{ failures() }}</p>
        }
        @if (analysis.qualityFlags.includes('NO_SPEECH_DETECTED')) {
          <p class="notice">
            Речь не обнаружена. Это результат проверки, а не ошибка распознавания.
          </p>
        }
        <div class="tabs" role="tablist" [attr.aria-label]="'Результаты анализа: ' + name()">
          @for (tab of tabs; track tab.id) {
            <button
              #analysisTab
              type="button"
              role="tab"
              [class.active]="section() === tab.id"
              [id]="'audio-' + id() + '-' + tab.id"
              [attr.aria-selected]="section() === tab.id"
              [attr.aria-controls]="'audio-' + id() + '-panel'"
              [tabIndex]="section() === tab.id ? 0 : -1"
              (click)="select(tab.id)"
              (keydown)="tabKey($event, $index)"
            >
              {{ tab.label }}
            </button>
          }
        </div>
        <div
          role="tabpanel"
          [id]="'audio-' + id() + '-panel'"
          [attr.aria-labelledby]="'audio-' + id() + '-' + section()"
          [attr.aria-busy]="loading()"
        >
          @if (section() !== 'transcript') {
            <div class="audio-range">
              <label
                >От, с <input type="number" min="0" [value]="from()" (change)="setFrom($event)"
              /></label>
              <span>до {{ number(from() + 20) }} с</span>
            </div>
          }
          @if (page(); as data) {
            @if (!data.sectionComplete) {
              <p class="notice">{{ sectionNotice() }}</p>
            }
            @if (data.items.length) {
              <div class="measurements">
                <hg-data-table
                  [view]="table"
                  [rows]="data.items"
                  [label]="tableLabel()"
                  [sortable]="false"
                >
                  <ng-template hgCell="start" [hgCellOf]="data.items" let-item>{{
                    number(item.start)
                  }}</ng-template>
                  <ng-template hgCell="end" [hgCellOf]="data.items" let-item>{{
                    number(item.end)
                  }}</ng-template>
                  <ng-template hgCell="text" [hgCellOf]="data.items" let-item>{{
                    item.text
                  }}</ng-template>
                  <ng-template hgCell="kind" [hgCellOf]="data.items" let-item>{{
                    kind(item.kind)
                  }}</ng-template>
                  <ng-template hgCell="duration" [hgCellOf]="data.items" let-item>{{
                    number(item.end - item.start)
                  }}</ng-template>
                  <ng-template hgCell="rms" [hgCellOf]="data.items" let-item>{{
                    number(item.rmsDbfs)
                  }}</ng-template>
                  <ng-template hgCell="peak" [hgCellOf]="data.items" let-item>{{
                    number(item.peakDbfs)
                  }}</ng-template>
                  <ng-template hgCell="pitch" [hgCellOf]="data.items" let-item>{{
                    number(item.f0Hz)
                  }}</ng-template>
                  <ng-template hgCell="delta" [hgCellOf]="data.items" let-item>{{
                    number(item.deltaHz)
                  }}</ng-template>
                  <ng-template hgCell="reason" [hgCellOf]="data.items" let-item>
                    {{ item.digitalSilence ? 'Цифровая тишина' : reason(item.reason) || '—' }}
                  </ng-template>
                  @for (column of emotionColumns(); track column.key) {
                    <ng-template [hgCell]="column.key" [hgCellOf]="data.items" let-item>{{
                      score(item.scores?.[column.score])
                    }}</ng-template>
                  }
                </hg-data-table>
              </div>
            } @else {
              <p class="empty-small">В этом разделе и диапазоне пока нет данных.</p>
            }
            @if (cursor() || data.hasMore) {
              <div class="toolbar audio-pagination">
                <button class="button" [disabled]="loading() || !cursor()" (click)="first()">
                  В начало
                </button>
                <button class="button" [disabled]="loading() || !data.hasMore" (click)="next()">
                  Следующая страница
                </button>
              </div>
            }
            @if (section() === 'intervals' && analysis.mode === 'full') {
              <p class="audio-tempo">
                Темп по распознанным словам: {{ number(analysis.tempo.withPausesWpm) }} слов/мин с
                паузами; {{ number(analysis.tempo.withoutPausesWpm) }} без пауз.
              </p>
            }
            <p class="limitation">
              Таймкоды оценочные. Модель не разделяет голоса: перекрытия ограничивают анализ.
              @if (section() === 'emotions') {
                Оценки эмоций — выход классификатора, а не достоверные вероятности чувств человека.
              }
            </p>
          } @else if (loading()) {
            <p class="loading" role="status">Загружаем результаты анализа…</p>
          }
        </div>
      } @else if (loading()) {
        <p class="loading" role="status">Загружаем результаты анализа…</p>
      } @else if (!error()) {
        <p class="empty-small">Анализ этой записи ещё не запрошен.</p>
      }
      @if (error()) {
        <p class="error-banner" role="alert">
          {{ error() }} <button class="text-button" (click)="refresh()">Повторить чтение</button>
        </p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .audio-analysis {
      display: flex;
      flex-direction: column;
      gap: 16px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 16px;
    }
    .audio-heading {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .audio-download {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      min-width: 0;
      font-weight: 600;
    }
    .audio-download span {
      overflow-wrap: anywhere;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .audio-download hg-icon {
      width: 16px;
    }
    .audio-duration {
      margin-left: auto;
      color: var(--muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .tabs {
      margin: 0;
      gap: 4px;
    }
    .audio-range,
    .audio-range label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .audio-range {
      flex-wrap: wrap;
      margin-bottom: 12px;
      color: var(--muted);
    }
    input {
      width: 90px;
    }
    .progress {
      color: var(--muted);
    }
    .measurements {
      max-height: 380px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 7px;
      font-variant-numeric: tabular-nums;
    }
    .audio-pagination,
    .audio-tempo {
      margin-top: 12px;
    }
    .limitation {
      margin-top: 12px;
      color: var(--muted);
      font-size: 12px;
    }
  `,
})
export class AudioAnalysis {
  readonly id = input.required<string>();
  readonly name = input.required<string>();
  readonly state = signal<z.infer<typeof stateSchema> | null>(null);
  readonly page = signal<z.infer<typeof pageSchema> | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly section = signal<Section>('transcript');
  readonly cursor = signal('');
  readonly from = signal(0);
  readonly tabs: readonly { id: Section; label: string }[] = [
    { id: 'transcript', label: 'Текст' },
    { id: 'intervals', label: 'Речь и паузы' },
    { id: 'acoustics', label: 'Измерения' },
    { id: 'emotions', label: 'Оценки эмоций' },
  ];
  readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('analysisTab');
  readonly tableLabel = computed(
    () => this.tabs.find((tab) => tab.id === this.section())?.label + ': ' + this.name(),
  );
  readonly emotionColumns = computed(() => {
    const names = new Set<string>();
    for (const item of this.section() === 'emotions' ? (this.page()?.items ?? []) : []) {
      for (const name of Object.keys(item.scores ?? {})) names.add(name);
    }
    const labels: Record<string, string> = {
      angry: 'Злость',
      sad: 'Грусть',
      neutral: 'Нейтральность',
      positive: 'Позитив',
    };
    return [...names].map((name) => ({
      key: 'score:' + name,
      score: name,
      label: labels[name] ?? name,
      width: 150,
    }));
  });
  readonly columns = computed<readonly TableColumn[]>(() => {
    const time = [
      { key: 'start', label: 'Начало, с', width: 110 },
      { key: 'end', label: 'Конец, с', width: 110 },
    ];
    switch (this.section()) {
      case 'transcript':
        return [...time, { key: 'text', label: 'Текст речи', width: 720, className: 'text-cell' }];
      case 'intervals':
        return [
          ...time,
          { key: 'kind', label: 'Тип', width: 200 },
          { key: 'duration', label: 'Длительность, с', width: 180 },
        ];
      case 'acoustics':
        return [
          ...time,
          { key: 'kind', label: 'Измерение', width: 160 },
          { key: 'rms', label: 'RMS, dBFS', width: 130 },
          { key: 'peak', label: 'Пик, dBFS', width: 130 },
          { key: 'pitch', label: 'F0, Гц', width: 130 },
          { key: 'delta', label: 'Изменение F0, Гц', width: 160 },
          { key: 'reason', label: 'Примечание', width: 280 },
        ];
      case 'emotions':
        return [
          ...time,
          ...this.emotionColumns(),
          { key: 'reason', label: 'Примечание', width: 280 },
        ];
    }
  });
  readonly table = inject(TableViews).create(
    () => 'audio-' + this.section(),
    () => this.columns(),
    inject(QueryState),
  );
  readonly sectionNotice = computed(() => {
    const stage = this.state()?.stages[this.section()];
    if (stage === 'NOT_REQUESTED') return 'Этот раздел анализа не запрошен для записи.';
    if (stage === 'FAILED') return 'Раздел не завершён из-за ошибки. Показаны доступные данные.';
    return stage === 'QUEUED' || stage === 'RUNNING'
      ? 'Показана доступная часть. Анализ ещё выполняется.'
      : 'Показана доступная часть анализа.';
  });
  readonly failures = computed(() => {
    const current = this.state();
    return current
      ? [current.errorCode, ...Object.values(current.stageErrors)]
          .filter(Boolean)
          .map((value) => this.reason(value))
          .join('; ')
      : '';
  });
  private readonly api = inject(Api);
  private generation = 0;
  private initialized = false;

  constructor() {
    effect(() => {
      this.id();
      this.initialized = true;
      this.state.set(null);
      this.page.set(null);
      this.cursor.set('');
      void this.refresh();
    });
    inject(LiveEvents)
      .watch(['audio-analysis', 'sync'])
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (!this.initialized) return;
        if (
          event.resource === 'sync' ||
          !this.state() ||
          event.entityId === this.state()?.analysisId
        )
          void this.refresh();
      });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }

  async refresh() {
    const generation = ++this.generation;
    this.loading.set(true);
    try {
      const latest = await this.api.get('/api/artifacts/' + this.id() + '/analysis', latestSchema);
      if (generation !== this.generation) return;
      if (!latest.analysis) {
        this.state.set(null);
        this.page.set(null);
        this.error.set('');
        return;
      }
      if (!this.acceptState(latest.analysis)) return;
      const page = await this.api.get(
        '/api/audio/analyses/' + latest.analysis.analysisId,
        pageSchema,
        {
          section: this.section(),
          cursor: this.cursor() || '0',
          limit: 100,
          from: this.section() === 'transcript' ? undefined : this.from(),
          to: this.section() === 'transcript' ? undefined : this.from() + 20,
        },
      );
      if (generation !== this.generation || !this.acceptState(page)) return;
      this.page.set(page);
      this.error.set('');
    } catch (error: unknown) {
      if (generation === this.generation) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
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

  select(section: Section) {
    if (this.section() === section) return;
    this.section.set(section);
    this.first();
  }
  tabKey(event: KeyboardEvent, index: number) {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (index + this.tabs.length - 1) % this.tabs.length;
        break;
      case 'ArrowRight':
        next = (index + 1) % this.tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.tabButtons()[next]?.nativeElement.focus();
    this.select(this.tabs[next].id);
  }
  first() {
    this.cursor.set('');
    this.page.set(null);
    void this.refresh();
  }
  next() {
    const cursor = this.page()?.nextCursor;
    if (cursor) {
      this.cursor.set(cursor);
      void this.refresh();
    }
  }
  setFrom(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value >= 0 && value !== this.from()) {
      this.from.set(value);
      this.first();
    }
  }
  number(value: number | null | undefined) {
    return value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }
  score(value: number | undefined) {
    return value === undefined
      ? '—'
      : value.toLocaleString('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }
  kind(value: string | undefined) {
    const labels: Record<string, string> = {
      speech: 'Речь',
      pause: 'Пауза',
      loudness: 'Громкость',
      pitch: 'Высота тона',
    };
    return value ? (labels[value] ?? value) : '—';
  }
  reason(value: string | null | undefined) {
    if (!value) return '';
    const labels: Record<string, string> = {
      unvoiced: 'нет надёжного тона',
      unreliable: 'ненадёжный тон',
      insufficient_context: 'недостаточно сигнала для оценки тона',
      too_short: 'слишком короткий интервал',
      EMOTION_FAILED: 'не удалось оценить эмоции',
      DECODE_FAILED: 'запись повреждена или её формат не поддерживается',
      ASR_FAILED: 'не удалось распознать речь',
      ACOUSTICS_FAILED: 'не удалось измерить звучание',
      SPEECH_WITHOUT_TEXT: 'речь обнаружена, но текст не распознан',
      PROCESSOR_VERSION_CHANGED: 'модели обновлены — запустите анализ ещё раз',
      PROCESSOR_CONNECTION_LOST: 'связь с обработчиком прервана',
      PROCESSOR_BUSY: 'обработчик занят',
      LEASE_EXPIRED: 'обработка восстанавливается после прерывания',
    };
    return labels[value] ?? value;
  }
}
