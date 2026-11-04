const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originGuard({ publicBaseUrl = process.env.PUBLIC_BASE_URL } = {}) {
  return (request, response, next) => {
    if (!request.path.startsWith("/api/") || SAFE_METHODS.has(request.method)) {
      return next();
    }
    const origin = request.get("origin");
    if (!origin) return next();

    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return reject(response);
    }

    const allowedHosts = new Set([request.get("host")]);
    if (publicBaseUrl) {
      try {
        allowedHosts.add(new URL(publicBaseUrl).host);
      } catch {
        // Ignore an invalid PUBLIC_BASE_URL; the request host still applies.
      }
    }
    if (!allowedHosts.has(originHost)) return reject(response);
    next();
  };
}

function reject(response) {
  response.status(403).json({
    error: {
      code: "ORIGIN_NOT_ALLOWED",
      message: "请求来源不被允许",
      retryable: false
    }
  });
}
