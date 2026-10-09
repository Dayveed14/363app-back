/**
 * Express 4 does not automatically forward a rejected promise from an
 * async route handler to error-handling middleware — a `throw` inside an
 * async controller's catch block (the pattern every controller here uses
 * for a non-HttpError, i.e. an unexpected failure) becomes an unhandled
 * promise rejection instead, which crashes the entire Node process and
 * takes down every member's session, not just the one request that
 * failed. Wrapping every route with this is what makes "unexpected error"
 * actually mean "that request gets a 500", rather than "the server falls
 * over".
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Wraps every exported function on a controller module (`import * as
 * controller from "..."`) in asyncHandler, so a routes file can keep
 * writing `controller.thing` exactly as before — one line at the top of
 * the routes file instead of wrapping each individual route registration.
 */
export function wrapAsync(controllerModule) {
  const wrapped = {};
  for (const [name, fn] of Object.entries(controllerModule)) {
    wrapped[name] = typeof fn === "function" ? asyncHandler(fn) : fn;
  }
  return wrapped;
}
