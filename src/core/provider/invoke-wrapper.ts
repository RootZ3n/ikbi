import type { ModelRequest, ModelResponse } from "./contract.js";

export type InvokeNext = () => Promise<ModelResponse>;
export type ModelInvokeWrapper = (request: ModelRequest, next: InvokeNext) => Promise<ModelResponse>;

let wrapper: ModelInvokeWrapper = (_request, next) => next();

export function registerModelInvokeWrapper(nextWrapper: ModelInvokeWrapper): void {
  wrapper = nextWrapper;
}

export function wrapModelInvocation(request: ModelRequest, next: InvokeNext): Promise<ModelResponse> {
  return wrapper(request, next);
}
