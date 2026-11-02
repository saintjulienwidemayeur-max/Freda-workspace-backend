class HttpError extends Error {
  constructor(status, message, code) { super(message); this.name = 'HttpError'; this.status = status; this.code = code; }
}
module.exports = { HttpError };
