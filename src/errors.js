class HttpError extends Error {
  constructor(status, message, code, details) { super(message); this.name = 'HttpError'; this.status = status; this.code = code; if (details) this.details = details; }
}
module.exports = { HttpError };
