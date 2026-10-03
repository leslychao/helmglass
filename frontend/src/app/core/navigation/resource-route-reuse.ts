import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

@Injectable()
export class ResourceRouteReuse extends BaseRouteReuseStrategy {
  override shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    current: ActivatedRouteSnapshot,
  ): boolean {
    // A resource change destroys its pending reads, form state and mutation recovery owner.
    return (
      super.shouldReuseRoute(future, current) &&
      future.paramMap.get('id') === current.paramMap.get('id')
    );
  }
}
