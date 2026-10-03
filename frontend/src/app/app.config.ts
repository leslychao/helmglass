import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { RouteReuseStrategy, provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideHttpClient, withXsrfConfiguration } from '@angular/common/http';
import { ResourceRouteReuse } from './core/navigation/resource-route-reuse';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(
      withXsrfConfiguration({ cookieName: '__Host-helm_csrf', headerName: 'X-XSRF-TOKEN' }),
    ),
    provideBrowserGlobalErrorListeners(),
    { provide: RouteReuseStrategy, useClass: ResourceRouteReuse },
    provideRouter(routes),
  ],
};
