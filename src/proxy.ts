import { NextResponse, type NextRequest } from "next/server";
import { isAllowedHost, resolveAllowedPort } from "@/config/server";

/**
 * Runs before every request (pages, API routes and static assets: there is deliberately no matcher).
 * Rejects any request whose Host header is not an approved local form, which blocks DNS-rebinding
 * pages from reading the dashboard through a hostname they control. This is one layer, not a complete
 * defense: it does not stop other processes on this machine from connecting directly to the port.
 */
export function proxy(request: NextRequest): NextResponse {
  if (isAllowedHost(request.headers.get("host"), resolveAllowedPort(process.env))) return NextResponse.next();
  return new NextResponse("Forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
