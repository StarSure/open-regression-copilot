import yaml from "js-yaml";
import { nanoid } from "nanoid";
import type { HttpMethod, RawRequest } from "./types.js";

const supportedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

export function parseOpenApi(input: string): RawRequest[] {
  const parsed = parseJsonOrYaml(input) as {
    servers?: Array<{ url?: string }>;
    paths?: Record<
      string,
      Partial<
        Record<
          Lowercase<HttpMethod>,
          {
            summary?: string;
            requestBody?: {
              content?: Record<string, { example?: unknown; schema?: Record<string, unknown> }>;
            };
            responses?: Record<string, { content?: Record<string, { example?: unknown; schema?: Record<string, unknown> }> }>;
          }
        >
      >
    >;
  };

  const baseUrl = parsed.servers?.[0]?.url ?? "https://api.example.com";
  const requests: RawRequest[] = [];

  for (const [path, operations] of Object.entries(parsed.paths ?? {})) {
    for (const method of supportedMethods) {
      const operation = operations?.[method.toLowerCase() as Lowercase<HttpMethod>];
      if (!operation) {
        continue;
      }

      const responseStatus = Object.keys(operation.responses ?? {})[0] ?? "200";
      const responseContent = firstContent(operation.responses?.[responseStatus]?.content);
      const requestContent = firstContent(operation.requestBody?.content);

      requests.push({
        id: nanoid(),
        method,
        url: joinUrl(baseUrl, path),
        status: Number(responseStatus) || 200,
        requestHeaders: requestContent ? { "content-type": requestContent.mimeType } : {},
        responseHeaders: responseContent ? { "content-type": responseContent.mimeType } : {},
        requestBody: requestContent?.example,
        responseBody: responseContent?.example,
        source: "manual"
      });
    }
  }

  return requests;
}

export function parsePostmanCollection(input: string): RawRequest[] {
  const parsed = parseJsonOrYaml(input) as {
    item?: Array<{
      item?: Array<unknown>;
      request?: {
        method?: string;
        header?: Array<{ key?: string; value?: string }>;
        url?: {
          raw?: string;
        };
        body?: {
          raw?: string;
        };
      };
      response?: Array<{
        code?: number;
        header?: Array<{ key?: string; value?: string }>;
        body?: string;
      }>;
    }>;
  };

  const requests: RawRequest[] = [];

  flattenPostmanItems(parsed.item ?? []).forEach((item) => {
    const method = normalizeMethod(item.request?.method);
    const url = item.request?.url?.raw;

    if (!method || !url) {
      return;
    }

    const firstResponse = item.response?.[0];
    requests.push({
      id: nanoid(),
      method,
      url,
      status: firstResponse?.code ?? 200,
      requestHeaders: headersToRecord(item.request?.header),
      responseHeaders: headersToRecord(firstResponse?.header),
      requestBody: safeJsonParse(item.request?.body?.raw),
      responseBody: safeJsonParse(firstResponse?.body),
      source: "manual"
    });
  });

  return requests;
}

export function parseCurl(input: string): RawRequest[] {
  const lines = input
    .split(/\\\n|\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const joined = lines.join(" ");
  const methodMatch = joined.match(/(?:-X|--request)\s+([A-Z]+)/i);
  const urlMatch = joined.match(/curl\s+['"]?([^'"\s]+)['"]?/i);
  const headerMatches = Array.from(joined.matchAll(/(?:-H|--header)\s+['"]([^:]+):\s*([^'"]+)['"]/gi));
  const dataMatch = joined.match(/(?:--data|-d|--data-raw)\s+['"](.+?)['"]/i);

  const method = normalizeMethod(methodMatch?.[1] ?? (dataMatch ? "POST" : "GET"));
  const url = urlMatch?.[1];

  if (!method || !url) {
    return [];
  }

  return [
    {
      id: nanoid(),
      method,
      url,
      status: 200,
      requestHeaders: Object.fromEntries(headerMatches.map((match) => [match[1].toLowerCase(), match[2]])),
      responseHeaders: {},
      requestBody: safeJsonParse(dataMatch?.[1]),
      responseBody: undefined,
      source: "manual"
    }
  ];
}

function parseJsonOrYaml(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return yaml.load(input);
  }
}

function firstContent(content?: Record<string, { example?: unknown; schema?: Record<string, unknown> }>) {
  const [mimeType, value] = Object.entries(content ?? {})[0] ?? [];
  if (!mimeType || !value) {
    return null;
  }

  return {
    mimeType,
    example: value.example ?? schemaExample(value.schema)
  };
}

function schemaExample(schema?: Record<string, unknown>) {
  if (!schema) {
    return undefined;
  }

  if (schema.example !== undefined) {
    return schema.example;
  }

  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    return Object.fromEntries(
      Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([key, value]) => [
        key,
        value.example ?? exampleForType(value.type)
      ])
    );
  }

  return exampleForType(schema.type);
}

function exampleForType(type: unknown) {
  if (type === "string") {
    return "example";
  }
  if (type === "number" || type === "integer") {
    return 1;
  }
  if (type === "boolean") {
    return true;
  }
  if (type === "array") {
    return [];
  }
  return undefined;
}

function flattenPostmanItems(items: Array<{ item?: Array<unknown> } | unknown>) {
  const result: Array<{
    request?: {
      method?: string;
      header?: Array<{ key?: string; value?: string }>;
      url?: { raw?: string };
      body?: { raw?: string };
    };
    response?: Array<{
      code?: number;
      header?: Array<{ key?: string; value?: string }>;
      body?: string;
    }>;
  }> = [];

  for (const item of items) {
    const candidate = item as {
      item?: Array<unknown>;
      request?: {
        method?: string;
        header?: Array<{ key?: string; value?: string }>;
        url?: { raw?: string };
        body?: { raw?: string };
      };
      response?: Array<{
        code?: number;
        header?: Array<{ key?: string; value?: string }>;
        body?: string;
      }>;
    };

    if (candidate.item) {
      result.push(...flattenPostmanItems(candidate.item));
    } else if (candidate.request) {
      result.push(candidate);
    }
  }

  return result;
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function normalizeMethod(method?: string): HttpMethod | null {
  const upper = method?.toUpperCase();
  return supportedMethods.includes(upper as HttpMethod) ? (upper as HttpMethod) : null;
}

function headersToRecord(headers?: Array<{ key?: string; value?: string }>) {
  return Object.fromEntries((headers ?? []).map((header) => [(header.key ?? "").toLowerCase(), header.value ?? ""]));
}

function safeJsonParse(value?: string) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

