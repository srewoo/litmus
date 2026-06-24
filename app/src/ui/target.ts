/** Parse the panel's "provider/model" target string into a validated TargetModel. */
import type { TargetModel } from '../shared/types';
import { TargetModelSchema } from '../shared/schema';

export function parseTarget(value: string): TargetModel {
  const slash = value.indexOf('/');
  const provider = slash >= 0 ? value.slice(0, slash) : value;
  const model = slash >= 0 ? value.slice(slash + 1) : '';
  return TargetModelSchema.parse({ provider, model });
}
