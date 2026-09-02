export interface HttpStatusResponse {
  status: number;
}

/**
 * A 428 response is an approval checkpoint for the current command. It is not
 * a reason to discard that command or to create an unbounded retry loop.
 */
export async function requestWithStepUp<T extends HttpStatusResponse>(
  fetchOnce: () => Promise<T>,
  requestStepUp: () => Promise<void>,
  authenticated: () => boolean,
): Promise<T> {
  let response = await fetchOnce();
  if (response.status === 428 && authenticated()) {
    await requestStepUp();
    response = await fetchOnce();
  }
  return response;
}
