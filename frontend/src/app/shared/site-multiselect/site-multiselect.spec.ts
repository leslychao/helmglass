import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Api } from '../../core/api/api.service';
import { Query, SiteSuggestions } from '../../core/api/models';
import { SiteMultiselect } from './site-multiselect';

describe('site filter URL restoration', () => {
  it('restores owned labels and ignores an obsolete response after URL navigation', async () => {
    const first = new Subject<SiteSuggestions>();
    const second = new Subject<SiteSuggestions>();
    const get = vi
      .fn((_path: string, _query?: Query) => first)
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { get } }] });
    const fixture = TestBed.createComponent(SiteMultiselect);
    const filter = fixture.componentInstance;
    fixture.componentRef.setInput('selectedIds', ['first-site']);
    fixture.detectChanges();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0]?.[1]).toMatchObject({
      selectedId: ['first-site'],
      excludeId: ['first-site'],
      limit: 3,
      scope: 'tasks',
    });
    fixture.componentRef.setInput('selectedIds', ['second-site', 'unavailable-site']);
    fixture.detectChanges();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    second.next({
      items: [],
      hasMore: false,
      selected: [{ id: 'second-site', host: 'example.com', displayName: 'Example' }],
    });
    second.complete();
    first.next({
      items: [],
      hasMore: false,
      selected: [{ id: 'first-site', host: 'obsolete.test', displayName: 'Obsolete' }],
    });
    expect(filter.chips()).toEqual([
      { id: 'second-site', label: 'Example' },
      { id: 'unavailable-site', label: 'Сайт недоступен' },
    ]);
    const changed = vi.fn();
    filter.changed.subscribe(changed);
    filter.remove('unavailable-site');
    expect(changed).toHaveBeenCalledWith(['second-site']);
    fixture.destroy();
  });
});
