export type ApiSuccess<T> = {
  data: T;
  version: number;
  operationId?: string;
};

export type ApiFailure = {
  error: {
    code: string;
    message: string;
    operationId: string;
    fields?: Readonly<Record<string, string>>;
  };
};

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};
