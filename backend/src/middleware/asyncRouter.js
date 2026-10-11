/**
 * Drop-in for express.Router() whose route handlers may be async.
 *
 * Express 4 ignores the promise an async handler returns: a rejection (e.g. the
 * database briefly unreachable) would leave the request hanging and surface as
 * an unhandled rejection. Here every handler's rejection is passed to next(),
 * so the central error handler in server.js answers it.
 */
import express from 'express';

const wrap = (fn) => (typeof fn !== 'function' || fn.length === 4) ? fn
  : function wrapped(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };

export function Router(options) {
  const router = express.Router(options);
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}
