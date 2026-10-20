export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(message = "Not found"): never {
  throw new AppError(404, message);
}

export function forbidden(message = "Forbidden"): never {
  throw new AppError(403, message);
}

export function badRequest(message: string): never {
  throw new AppError(400, message);
}

export function conflict(message: string): never {
  throw new AppError(409, message);
}
