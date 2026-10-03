import { UsageMetric } from '../../core/api/models';
import { BytesPipe, DurationPipe } from './status';

export type UsageUnit = 'seconds' | 'bytes' | 'count';
const duration = new DurationPipe();
const bytes = new BytesPipe();

export function usageValue(metric: UsageMetric, unit: UsageUnit, showKnown = false): string {
  if (metric.value !== null) return measuredValue(metric.value, unit);
  if (showKnown && metric.completeness === 'PARTIAL' && metric.knownValue !== null)
    return '≥ ' + measuredValue(metric.knownValue, unit);
  return metric.completeness === 'PARTIAL' ? 'Нет полных данных' : 'Нет данных';
}

export function measuredValue(value: number | null, unit: string): string {
  if (value === null) return 'Нет данных';
  if (unit === 'seconds') return duration.transform(value);
  if (unit === 'bytes') return bytes.transform(value);
  if (unit === 'count') return value.toLocaleString('ru-RU');
  return value.toLocaleString('ru-RU') + ' ' + unit;
}
