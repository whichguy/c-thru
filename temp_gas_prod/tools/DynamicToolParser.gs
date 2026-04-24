function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * DynamicToolParser - Converts param notation to JSON Schema
   * 
   * Hybrid notation syntax:
   *   name[: type][!][ = default], ...
   *   name[]: type[!][ = default], ...  (array notation)
   * 
   * Examples:
   *   weight_class!, page = 1, limit = 100
   *   weight_class: string!, page: int = 1
   *   states[] = [], ids[]: int!, names[]
   *   (empty) = accept any JSON
   * 
   * Notation:
   *   param!       - Required parameter
   *   param        - Optional parameter (implicit)
   *   param = val  - Optional with default
   *   param: type  - Optional type hint (for documentation, not validation)
   */

  class DynamicToolParser {
    /**
     * Parse hybrid param notation into JSON Schema
     * 
     * @param {string} notation - Param notation string (e.g., "weight_class!, page = 1")
     * @returns {Object} JSON Schema object with _defaults metadata
     * 
     * @example
     * // Empty notation = accept any object
     * parseParams('') // => { type: "object", properties: {}, _defaults: {} }
     * 
     * @example
     * // Required + optional with default
     * parseParams('id!, count = 10')
     * // => { type: "object", properties: { id: {}, count: { default: 10 } }, required: ["id"], _defaults: { count: 10 } }
     */
    static parseParams(notation) {
      // Empty or whitespace = accept any object (liberal mode)
      if (!notation || !notation.trim()) {
        return { 
          type: "object", 
          properties: {},
          _defaults: {}
        };
      }

      const properties = {};
      const required = [];
      const defaults = {};

      // Split by comma, handling potential whitespace
      const params = notation.split(',').map(p => p.trim()).filter(Boolean);

      params.forEach(param => {
        // Parse: name[[]]: type[!][ = default]
        // Regex breakdown:
        //   ^(\w+)            - param name (capture group 1)
        //   (\[\])?           - optional array notation (capture group 2)
        //   (?::\s*(\w+))?    - optional type hint (capture group 3)
        //   (!)?              - optional required marker (capture group 4)
        //   (?:\s*=\s*(.+))?$ - optional default value (capture group 5)
        const match = param.match(/^(\w+)(\[\])?(?::\s*(\w+))?(!)?\s*(?:=\s*(.+))?$/);
        
        if (!match) {
          Logger.log(`[DynamicToolParser] Skipping invalid param notation: "${param}"`);
          return;
        }

        const [, name, arrayNotation, typeHint, isRequired, defaultVal] = match;
        const isArray = arrayNotation === '[]';

        // Build property object
        const prop = {};

        // Type hint is for documentation only (Claude infers from description anyway)
        if (isArray) {
          // Array notation
          prop.type = 'array';
          
          if (typeHint) {
            // Map common type aliases
            const typeMap = {
              'int': 'integer',
              'str': 'string', 
              'bool': 'boolean',
              'num': 'number'
            };
            const mappedType = typeMap[typeHint.toLowerCase()] || typeHint.toLowerCase();
            
            // Set items type for array
            const validTypes = ['string', 'number', 'integer', 'boolean', 'object'];
            if (validTypes.includes(mappedType)) {
              prop.items = { type: mappedType };
            }
          } else {
            // Default to string items if no type specified
            prop.items = { type: 'string' };
          }
        } else if (typeHint) {
          // Map common type aliases
          const typeMap = {
            'int': 'integer',
            'str': 'string', 
            'bool': 'boolean',
            'num': 'number',
            'arr': 'array',
            'obj': 'object'
          };
          const mappedType = typeMap[typeHint.toLowerCase()] || typeHint.toLowerCase();
          
          // Only include type if it's a valid JSON Schema type
          const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
          if (validTypes.includes(mappedType)) {
            prop.type = mappedType;
          }
        }

        // Parse and store default value
        if (defaultVal !== undefined) {
          const parsed = this._parseDefaultValue(defaultVal.trim());
          prop.default = parsed;
          defaults[name] = parsed;
        }

        // ! suffix means required
        if (isRequired) {
          required.push(name);
        }

        properties[name] = prop;
      });

      // Build final schema
      const schema = { 
        type: "object", 
        properties 
      };
      
      if (required.length > 0) {
        schema.required = required;
      }

      // Store defaults for handler to apply before execution
      schema._defaults = defaults;

      return schema;
    }

    /**
     * Parse default value string - infer type from format
     * 
     * @param {string} val - Default value string
     * @returns {*} Parsed value (number, boolean, string, or original)
     * @private
     */
    static _parseDefaultValue(val) {
      // Integer
      if (/^-?\d+$/.test(val)) {
        return parseInt(val, 10);
      }
      
      // Float
      if (/^-?\d*\.\d+$/.test(val)) {
        return parseFloat(val);
      }

      // Boolean
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;

      // Null
      if (val.toLowerCase() === 'null') return null;

      // Quoted string - remove quotes
      if (/^["'].*["']$/.test(val)) {
        return val.slice(1, -1);
      }

      // JSON array or object
      if ((val.startsWith('[') && val.endsWith(']')) || 
          (val.startsWith('{') && val.endsWith('}'))) {
        try {
          return JSON.parse(val);
        } catch (e) {
          // Not valid JSON, return as string
          return val;
        }
      }

      // Unquoted string (return as-is)
      return val;
    }

    /**
     * Apply defaults to input object
     * Modifies input in place and returns it
     * 
     * @param {Object} input - Tool input from Claude
     * @param {Object} schema - Schema with _defaults from parseParams
     * @returns {Object} Input with defaults applied
     */
    static applyDefaults(input, schema) {
      // Validate input
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('applyDefaults requires input to be an object');
      }
      if (!schema || typeof schema !== 'object') {
        throw new Error('applyDefaults requires schema to be an object');
      }
      
      const defaults = schema._defaults || {};
      
      Object.keys(defaults).forEach(key => {
        if (input[key] === undefined) {
          // Deep copy arrays to avoid shared references
          if (Array.isArray(defaults[key])) {
            input[key] = JSON.parse(JSON.stringify(defaults[key]));
          } else {
            input[key] = defaults[key];
          }
        }
      });
      
      return input;
    }

    /**
     * Validate input against schema
     * Returns validation result with detailed error messages
     * 
     * @param {Object} input - Tool input to validate
     * @param {Object} schema - JSON Schema from parseParams
     * @returns {{valid: boolean, errors: string[]}}
     */
    static validateInput(input, schema) {
      // Validate input
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {
          valid: false,
          errors: ['Input must be an object']
        };
      }
      if (!schema || typeof schema !== 'object') {
        return {
          valid: false,
          errors: ['Schema must be an object']
        };
      }
      
      const errors = [];

      // Check required fields
      if (schema.required) {
        for (const field of schema.required) {
          if (input[field] === undefined || input[field] === null) {
            errors.push(`Missing required parameter: '${field}'`);
          }
        }
      }

      // Type checking (optional, only if types are specified)
      if (schema.properties) {
        Object.entries(schema.properties).forEach(([name, prop]) => {
          const value = input[name];
          
          // Skip undefined values (already checked in required)
          if (value === undefined) return;
          
          // Type validation
          if (prop.type && value !== null) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            
            // Handle integer vs number
            if (prop.type === 'integer') {
              if (typeof value !== 'number' || !Number.isInteger(value)) {
                errors.push(`Parameter '${name}' must be an integer, got ${actualType}`);
              }
            } else if (prop.type === 'number') {
              if (typeof value !== 'number') {
                errors.push(`Parameter '${name}' must be a number, got ${actualType}`);
              }
            } else if (prop.type === 'array') {
              if (!Array.isArray(value)) {
                errors.push(`Parameter '${name}' must be an array, got ${actualType}`);
              } else if (prop.items && prop.items.type) {
                // Validate array item types
                value.forEach((item, idx) => {
                  // Handle null items explicitly
                  if (item === null) {
                    if (prop.items.type !== 'null') {
                      errors.push(`Parameter '${name}[${idx}]' is null but type should be ${prop.items.type}`);
                    }
                    return;
                  }
                  
                  const itemType = Array.isArray(item) ? 'array' : typeof item;
                  
                  if (prop.items.type === 'integer') {
                    if (typeof item !== 'number' || !Number.isInteger(item)) {
                      errors.push(`Parameter '${name}[${idx}]' must be an integer, got ${itemType}`);
                    }
                  } else if (prop.items.type === 'number') {
                    if (typeof item !== 'number') {
                      errors.push(`Parameter '${name}[${idx}]' must be a number, got ${itemType}`);
                    }
                  } else if (prop.items.type !== itemType) {
                    errors.push(`Parameter '${name}[${idx}]' must be ${prop.items.type}, got ${itemType}`);
                  }
                });
              }
            } else if (prop.type !== actualType) {
              errors.push(`Parameter '${name}' must be ${prop.type}, got ${actualType}`);
            }
          }
        });
      }

      return {
        valid: errors.length === 0,
        errors
      };
    }
  }

  module.exports = DynamicToolParser;
}

__defineModule__(_main);