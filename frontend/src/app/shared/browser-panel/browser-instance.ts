import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class BrowserInstance {
  readonly id = crypto.randomUUID();
}
