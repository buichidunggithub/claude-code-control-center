import type { Analysis, ApiEnvelope, ParamResult } from "@/core/analysis";
import { getAnalysis } from "./analysis";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const HTTP_UNAVAILABLE = 503;

const json = (body: unknown, status: number): Response => Response.json(body, { status, headers: HEADERS });

/**
 * A read-only GET handler: parse the query strictly, run one analysis operation, return the envelope.
 * Validation errors name the parameter only. An unusable database is 503 with a fixed code; a missing
 * database or scan is a normal 200 empty state, never an invented zero.
 */
export function readOnlyRoute<Q, T>(
  parse: (query: URLSearchParams) => ParamResult<Q>,
  operation: (analysis: Analysis, query: Q) => ApiEnvelope<T>,
): (request: Request) => Response {
  return (request) => {
    const query = parse(new URL(request.url).searchParams);
    if (!query.ok) return json({ state: "invalid-request", data: null, errorCode: "INVALID_PARAMETER", parameter: query.parameter }, 400);
    const result = operation(getAnalysis(), query.value);
    return json(result, result.state === "unavailable" ? HTTP_UNAVAILABLE : 200);
  };
}
