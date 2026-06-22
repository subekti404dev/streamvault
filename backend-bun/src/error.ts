export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) { super(message); this.name = "AppError"; }
}

export function notFound(msg: string): AppError {
  return new AppError(404, msg);
}
export function badRequest(msg: string): AppError {
  return new AppError(400, msg);
}
export function unauthorized(): AppError {
  return new AppError(401, "Unauthorized");
}
export function internal(msg: string): AppError {
  return new AppError(500, msg);
}
export function badGateway(msg: string): AppError {
  return new AppError(502, msg);
}
