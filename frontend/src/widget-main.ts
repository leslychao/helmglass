import { provideHttpClient } from '@angular/common/http';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { Widget } from './app/features/widget/widget';

bootstrapApplication(Widget, {
  providers: [
    provideHttpClient(),
    provideBrowserGlobalErrorListeners(),
    provideRouter([], withDisabledInitialNavigation()),
  ],
}).catch((error: unknown) => console.error(error));
