export interface ModelRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  role?: string;
}

export interface ModelResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface ModelClient {
  readonly providerName: string;
  readonly modelName: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
