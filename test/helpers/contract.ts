// expectContract: valida a resposta real contra o schema do openapi.yaml para aquele método + status.
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { LightMyRequestResponse } from 'fastify';
import path from 'node:path';

// Interop CJS → ESM
const Ajv2020 = ((Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import) as typeof Ajv2020Import;
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ??
  addFormatsImport) as typeof addFormatsImport;

type Schema = Record<string, unknown>;
interface Spec {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>>;
}

let specPromise: Promise<Spec> | undefined;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

const loadSpec = () =>
  (specPromise ??= SwaggerParser.dereference(path.resolve('docs/specs/openapi.yaml')) as unknown as Promise<Spec>);

/**
 * @param pathTemplate caminho como está no openapi.yaml, sem /api/v1 (ex.: '/items/{itemId}/select-ngo').
 */
export async function expectContract(res: LightMyRequestResponse, method: string, pathTemplate: string) {
  const spec = await loadSpec();
  const op = spec.paths[pathTemplate]?.[method.toLowerCase()];
  if (!op) throw new Error(`Contrato: ${method} ${pathTemplate} não existe no openapi.yaml`);

  const status = String(res.statusCode);
  const response = op.responses[status];
  if (!response) throw new Error(`Contrato: status ${status} não documentado em ${method} ${pathTemplate}`);

  const schema = response.content?.['application/json']?.schema;
  if (!schema) {
    if (res.body !== '') throw new Error(`Contrato: ${method} ${pathTemplate} ${status} não deveria ter corpo`);
    return;
  }

  const key = `${method} ${pathTemplate} ${status}`;
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }

  const body = res.json();
  if (!validate(body)) {
    throw new Error(
      `Contrato: resposta de ${key} fora do schema:\n${ajv.errorsText(validate.errors, { separator: '\n' })}\n` +
        `Corpo: ${JSON.stringify(body, null, 2)}`,
    );
  }
}
