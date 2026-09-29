// A failed API call, with its HTTP status so callers can act on it.
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// The error to show for a failed API call. A request refused for coming too
// often (429) or while the model's line is full (503) carries the server's own
// words, such as "Too many requests, try again in N s"; anything else names
// the call and its status.
export async function failure(res: Response, what: string): Promise<HttpError> {
  if (res.status === 429 || res.status === 503) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null
    if (typeof body?.detail === "string") return new HttpError(body.detail, res.status)
  }
  return new HttpError(`${what} -> ${res.status}`, res.status)
}

// True for a 404: the conversation asked about no longer exists (deleted by
// the browser, or by the server after its retention period).
export function isGone(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404
}
