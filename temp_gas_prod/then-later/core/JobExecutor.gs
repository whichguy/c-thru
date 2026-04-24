function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  class FunctionPathError extends Error {
    constructor(message) {
      super(`Function path error: ${message}`);
      this.name = 'FunctionPathError';
    }
  }

  class JobExecutionError extends Error {
    constructor(path, originalError) {
      super(`Job execution failed at ${path}: ${originalError.message}`);
      this.name = 'JobExecutionError';
      this.stack = originalError.stack;
      this.stepPath = path;
      this.originalError = originalError;
    }
  }

  /**
   * Executes job steps with secure function path resolution.
   * Expression evaluation ($expr: syntax) is not supported in GAS V8.
   */
  class JobExecutor {
    validateFunctionPath(path) {
      log('Validating function path | ' + JSON.stringify({ path }));

      try {
        const fn = this.resolveFunction(path);
        if (typeof fn !== 'function') {
          throw new FunctionPathError(`Path '${path}' does not resolve to a function`);
        }
      } catch (e) {
        throw new FunctionPathError(`Invalid function path '${path}': ${e.message}`);
      }
    }

    resolveFunction(path) {
      log('Resolving function path | ' + JSON.stringify({ path }));

      const validPathRegex = /^([\w$]+(\.[\w$]+|\[\'[\w$]+\'\]|\[\d+\])*)+$/;
      if (!validPathRegex.test(path)) {
        throw new FunctionPathError(`Malformed function path: ${path}`);
      }

      // Deny list of dangerous terms
      const blockedTerms = [
        'constructor', 'prototype', '__proto__', 'eval', 'Function',
        'system', 'call', 'apply', 'bind', 'Proxy', 'XMLHttpRequest'
      ];

      const parts = [];
      const tokenRegex = /([\w$]+)|\[(['"])(.+?)\2\]|\[(\d+)\]/g;
      let match;

      while ((match = tokenRegex.exec(path)) !== null) {
        if (match[1]) {
          parts.push(match[1]);
        } else if (match[3]) {
          parts.push(match[3]);
        } else if (match[4]) {
          parts.push(match[4]);
        }
      }

      if (parts.length === 0) {
        throw new FunctionPathError(`Empty function path: ${path}`);
      }

      for (const part of parts) {
        if (blockedTerms.includes(part)) {
          throw new FunctionPathError(`Path contains potentially unsafe term: ${part}`);
        }
      }

      let current = globalThis;
      for (const [index, part] of parts.entries()) {
        if (current[part] === undefined) {
          const missingPath = parts.slice(0, index + 1).join('.');
          throw new FunctionPathError(
            `Missing '${part}' in path '${path}' (failed at ${missingPath})`
          );
        }

        if (index > 0 && (
          current === Object.prototype ||
          current === Function.prototype ||
          current === Array.prototype)) {
          throw new FunctionPathError(
            `Path '${path}' attempts to access prototype methods`
          );
        }

        current = current[part];
      }

      if (typeof current !== 'function') {
        throw new FunctionPathError(
          `Path '${path}' resolves to non-function (${typeof current})`
        );
      }

      return current;
    }

    executeStep(step, prevResult, context = {}) {
      if (!step.functionPath || typeof step.functionPath !== 'string') {
        throw new Error(`Invalid step: missing or invalid functionPath`);
      }

      if (!step.parameters || !Array.isArray(step.parameters)) {
        throw new Error(`Invalid step: missing or invalid parameters array`);
      }

      try {
        const fn = this.resolveFunction(step.functionPath);

        const resolvedArgs = this.resolveStepArguments(
          step.parameters,
          prevResult,
          context
        );

        log('Executing step | ' + JSON.stringify({ functionPath: step.functionPath, argCount: resolvedArgs.length }));

        const result = fn(...resolvedArgs);

        log('Step executed successfully | ' + JSON.stringify({ functionPath: step.functionPath, resultType: typeof result }));

        return result;
      } catch (e) {
        log('[E] Step execution failed: ' + e.message + ' | ' + JSON.stringify({ functionPath: step.functionPath }));
        throw new JobExecutionError(step.functionPath, e);
      }
    }

    resolveStepArguments(args, prevResult, context) {
      return args.map(arg => {
        if (arg !== null && typeof arg === 'object') {
          if (Array.isArray(arg)) {
            return this.resolveStepArguments(arg, prevResult, context);
          } else {
            const resolvedObj = {};
            for (const [key, value] of Object.entries(arg)) {
              if (value !== null && typeof value === 'object') {
                resolvedObj[key] = this.resolveStepArguments(
                  [value],
                  prevResult,
                  context
                )[0];
              } else {
                resolvedObj[key] = value;
              }
            }
            return resolvedObj;
          }
        }

        return arg;
      });
    }

    safeStringify(obj) {
      try {
        return JSON.stringify(obj, (key, value) => {
          if (typeof value === 'function') return '<function>';
          if (value instanceof Error) return `<Error: ${value.message}>`;
          return value;
        });
      } catch (e) {
        return '<unserializable object>';
      }
    }
  }

  module.exports = {
    JobExecutor,
    FunctionPathError,
    JobExecutionError
  };
}

__defineModule__(_main);