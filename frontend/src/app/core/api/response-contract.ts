import { responseContracts } from './generated/response-contracts';

const contracts = responseContracts
  .map((contract) => ({
    ...contract,
    segments: contract.path.split('/'),
  }))
  .sort(
    (left, right) =>
      left.segments.filter((part) => part.startsWith('{')).length -
      right.segments.filter((part) => part.startsWith('{')).length,
  );

export class ResponseContractError extends Error {
  constructor(readonly code: 'API_CONTRACT_MISSING' | 'API_RESPONSE_INVALID') {
    super(code);
  }
}

/** A malformed successful response is not proof that a mutation failed. */
export async function validateResponse(
  method: string,
  path: string,
  value: unknown,
): Promise<void> {
  const segments = path.split('/');
  const contract = contracts.find(
    (candidate) =>
      candidate.method === method &&
      candidate.segments.length === segments.length &&
      candidate.segments.every((part, index) =>
        part.startsWith('{') ? !!segments[index] : part === segments[index],
      ),
  );
  if (!contract) throw new ResponseContractError('API_CONTRACT_MISSING');
  const validators = await import('./generated/response-validators.js');
  if (!validators[contract.validator](value))
    throw new ResponseContractError('API_RESPONSE_INVALID');
}
