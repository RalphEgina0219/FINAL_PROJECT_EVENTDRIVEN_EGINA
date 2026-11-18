// An error whose message is safe to show to the user.
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

// Express 4 does not catch rejected promises; wrap async handlers so errors reach the error handler.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
