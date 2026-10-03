import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect } from 'vitest';
import { Query } from '../../core/api/models';
import { DataTable } from './data-table';

describe('server table sorting', () => {
  it('cycles ascending, descending, unsorted and starts another column ascending', () => {
    TestBed.configureTestingModule({ imports: [DataTable], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(DataTable);
    const column = { key: 'title', title: 'Задача', sort: 'title' };
    fixture.componentRef.setInput('columns', [column]);
    fixture.componentRef.setInput('rows', []);
    const base = { page: 4, pageSize: 10, total: 100 };
    fixture.componentRef.setInput('page', { ...base, sort: null });
    const changes: Query[] = [];
    fixture.componentInstance.changed.subscribe((value) => changes.push(value));
    fixture.componentInstance.sort(column);
    fixture.componentRef.setInput('page', { ...base, sort: { field: 'title', direction: 'asc' } });
    fixture.componentInstance.sort(column);
    fixture.componentRef.setInput('page', { ...base, sort: { field: 'title', direction: 'desc' } });
    fixture.componentInstance.sort(column);
    fixture.componentInstance.sort({ key: 'date', title: 'Дата', sort: 'createdAt' });
    expect(changes).toEqual([
      { sort: 'title', direction: 'asc', page: 1 },
      { sort: 'title', direction: 'desc', page: 1 },
      { sort: null, direction: null, page: 1 },
      { sort: 'createdAt', direction: 'asc', page: 1 },
    ]);
  });

  it('does not announce an empty result before a successful list response', () => {
    TestBed.configureTestingModule({ imports: [DataTable], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(DataTable);
    fixture.componentRef.setInput('columns', [{ key: 'title', title: 'Задача' }]);
    fixture.componentRef.setInput('rows', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Ничего не найдено');
    fixture.componentRef.setInput('page', { page: 1, pageSize: 10, total: 0, sort: null });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Ничего не найдено');
  });
});
