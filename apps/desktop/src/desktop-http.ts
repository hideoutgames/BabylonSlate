export type DesktopHttpRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export async function fetchDesktopHttp(
  request: DesktopHttpRequest,
  fetchRequest: (url: string, init: RequestInit) => Promise<Response>,
) {
  const response = await fetchRequest(request.url, {
    method: request.method ?? "GET",
    headers: request.headers ?? {},
    body: request.body,
    redirect: "error",
    credentials: "omit",
  });
  return {
    status: response.status,
    bodyText: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}
