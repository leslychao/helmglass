import {
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Icon } from '../shared/icon';
import { Api, errorMessage } from './api';
import { Me, meSchema } from './models';
import { Session } from './session';

@Component({
  selector: 'hg-profile',
  imports: [FormsModule, Icon],
  templateUrl: './profile.html',
  styleUrl: './profile.css',
  host: { '(window:beforeunload)': 'beforeUnload($event)' },
})
export class Profile {
  readonly session = inject(Session);
  private readonly api = inject(Api);
  private original: Me | null = null;
  readonly name = signal('');
  readonly photo = signal<File | null>(null);
  readonly preview = signal<string | null>(null);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('photoInput');
  constructor() {
    effect(() => {
      const user = this.session.user();
      if (user)
        untracked(() => {
          if (!this.hasChanges() && !this.saving()) this.reset(user);
        });
    });
    inject(DestroyRef).onDestroy(() => this.releasePreview());
  }
  hasChanges() {
    return this.original !== null && (this.name() !== this.original.name || this.photo() !== null);
  }
  beforeUnload(event: BeforeUnloadEvent) {
    if (this.hasChanges()) event.preventDefault();
  }
  choosePhoto(event: Event) {
    if (!(event.target instanceof HTMLInputElement)) return;
    const file = event.target.files?.item(0);
    if (!file) return;
    this.error.set('');
    this.saved.set(false);
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      this.error.set('Выберите PNG, JPG или WebP размером до 5 МБ.');
      event.target.value = '';
      return;
    }
    this.releasePreview();
    this.photo.set(file);
    this.preview.set(URL.createObjectURL(file));
  }
  cancel() {
    const user = this.session.user();
    if (user) this.reset(user);
    this.error.set('');
    this.saved.set(false);
  }
  async save() {
    if (this.saving() || !this.hasChanges() || !this.original) return;
    if (!this.name().trim()) {
      this.error.set('Введите имя и фамилию.');
      return;
    }
    this.saving.set(true);
    this.saved.set(false);
    this.error.set('');
    try {
      const body = new FormData();
      body.append('name', this.name().trim());
      body.append('expectedVersion', String(this.original.version));
      const photo = this.photo();
      if (photo) body.append('avatar', photo, photo.name);
      const user = await this.api.mutate('/api/me', body, meSchema);
      this.session.applyProfile(user);
      this.reset(this.session.user() ?? user);
      this.saved.set(true);
    } catch (error: unknown) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
  private reset(user: Me) {
    this.original = user;
    this.name.set(user.name);
    this.photo.set(null);
    this.releasePreview();
    const input = this.input();
    if (input) input.nativeElement.value = '';
  }
  private releasePreview() {
    const preview = this.preview();
    if (preview) URL.revokeObjectURL(preview);
    this.preview.set(null);
  }
}
