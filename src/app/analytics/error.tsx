"use client";

/** Request-error boundary. The error object is deliberately never read: its message could quote data or paths. */
export default function AnalyticsError() {
  return (
    <div role="alert" className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="text-2xl font-semibold">Event facts</h1>
      <p className="mt-3 text-sm">The event facts could not be displayed because of an unexpected error. No details are shown here. Reload the page to try again.</p>
    </div>
  );
}
